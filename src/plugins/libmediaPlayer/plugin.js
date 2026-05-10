import Screenfull from 'screenfull';
import DOMPurify from 'dompurify';
import debounce from 'lodash-es/debounce';

import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import loading from '../../components/loading/loading';
import { appRouter } from '../../components/router/appRouter';
import { setBackdropTransparency, TRANSPARENCY_LEVEL } from '../../components/backdrop/backdrop';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import * as htmlMediaHelper from '../../components/htmlMediaHelper';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { playbackManager } from '../../components/playback/playbackmanager';

function normalizeAVPlayerExports(mod) {
    const AVPlayer = mod?.default || window.AVPlayer;
    if (!AVPlayer) return null;

    if (!AVPlayer.Events && mod?.Events) {
        AVPlayer.Events = mod.Events;
    }
    if (!AVPlayer.eventType) {
        AVPlayer.eventType = AVPlayer.Events || mod?.Events || {};
    }
    if (!AVPlayer.RenderMode) {
        AVPlayer.RenderMode = { FIT: 0, FILL: 1 };
    }

    window.AVPlayer = AVPlayer;
    return AVPlayer;
}

function getAVPlayerLoadOptions(httpOptions) {
    return httpOptions ? { http: httpOptions } : undefined;
}

function zoomIn(elem) {
    return new Promise(resolve => {
        const duration = 240;
        elem.style.animation = `htmlvideoplayer-zoomin ${duration}ms ease-in normal`;
        const onFinish = () => {
            elem.removeEventListener('animationend', onFinish);
            resolve();
        };
        elem.addEventListener('animationend', onFinish, { once: true });
    });
}

async function ensureAVPlayerLoaded() {
    if (window.AVPlayer) {
        normalizeAVPlayerExports({});
        return;
    }
    // Prefer ESM to avoid import.meta errors in UMD on some setups
    try {
        // eslint-disable-next-line import/no-dynamic-require
        const mod = await (0, eval)('import(/**/ /* webpackIgnore: true */ "libraries/libmedia/esm/avplayer.js")');
        if (normalizeAVPlayerExports(mod)) {
            return;
        }
    } catch (_) { /* ignore */ }
    try {
        const mod = await (0, eval)('import(/**/ /* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/@libmedia/avplayer/dist/esm/avplayer.js")');
        if (normalizeAVPlayerExports(mod)) {
            return;
        }
    } catch (_) { /* ignore */ }
    // Final fallback to UMD if ESM unavailable
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'libraries/libmedia/avplayer.js';
        script.async = true;
        script.onload = () => {
            normalizeAVPlayerExports({});
            resolve();
        };
        script.onerror = (e) => reject(e);
        document.head.appendChild(script);
    });
}

function resolveUrl(url) {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', url, true);
        xhr.onload = function () { resolve(xhr.responseURL || url); };
        xhr.onerror = function () { resolve(url); };
        xhr.send(null);
    });
}

function tryRemoveElement(elem) {
    const parentNode = elem?.parentNode;
    if (parentNode) {
        try { parentNode.removeChild(elem); } catch (err) { console.error('error removing element', err); }
    }
}

class LibmediaPlayer {
    constructor() {
        this.name = 'Libmedia Player';
        this.type = PluginType.MediaPlayer;
        this.id = 'libmediaplayer';
        // Reuse HtmlVideoPlayer SyncPlay wrapper to avoid unknown-wrapper fallback
        this.syncPlayWrapAs = 'htmlvideoplayer';
        // Take priority over HTML players (which default to 1)
        this.priority = 0;
        // Let playbackmanager expand DeliveryUrl to absolute
        this.useFullSubtitleUrls = true;
        this.isLocalPlayer = true;
        this._currentSrc = null;
        this._volume = (htmlMediaHelper.getSavedVolume() || 0) * 100;
        this._muted = false;
        this._playlist = [];
        this._playlistIndex = 0;
        this._currentPlayOptions = null;
        // Subtitle state (Jellyfin-rendered)
        this._customTrackIndex = -1;
        this._customSecondaryTrackIndex = -1;
        this._currentTrackEvents = null;
        this._currentSecondaryTrackEvents = null;
        this._videoSubtitlesElem = null;
        this._videoSecondarySubtitlesElem = null;
        this._currentTrackOffset = 0;
        this._secondaryTrackOffset = 0;
        this._showSubtitleOffset = false;
        this.setSubtitleOffset = debounce(this._setSubtitleOffset.bind(this), 100);
        this._prefersMSE = true;
        this._wasmBaseUrl = null;
        this._httpOptions = null;
        // Bound handler for browser back/forward navigation (popstate)
        this._boundPopState = null;
        // Guard to avoid recursive fallback attempts
        this._inFallback = false;
        // MediaStream fallback time normalization state
        this._mediaStreamVideo = null;
        this._nativeCurrentTimeGet = null;
        this._nativeCurrentTimeSet = null;
        this._msClockOffsetSec = 0;
        this._msClockCalibrated = false;
        // Ghost/invisible helpers for subtitle rendering on canvas path
        this._ghostVideo = null;
        this._ghostUnpatch = null;
        this._pgsCustomCanvas = null;
        // External audio state
        this._externalAudioActive = false;
        this._extAudioSelectedIndex = null;
        this._extAudioElement = null;
        this._extAudioStream = null;
        this._extAudioPlayer = null;
        this._mutedMainDueToExternal = false;
        // Sync guards
        this._mainSeekInProgress = false;
        this._extAudioSeekInProgress = false;
        this._extAudioLastResyncTs = 0;
        this._extAudioPrimed = false;
        this._extAudioStreamIndex = -1;
    }

    canPlayMediaType(mediaType) {
        mediaType = (mediaType || '').toLowerCase();
        return mediaType === 'audio' || mediaType === 'video';
    }

    // Allow all server items; URL-only items fallback via createStreamInfoFromUrlItem
    canPlayItem() {
        return true;
    }

    supportsPlayMethod(playMethod /*, item */) {
        // Avoid server-side transcoding fallback
        return playMethod !== 'Transcode';
    }

    async getDeviceProfile(/* item */) {
        // Claim broad direct-play support and disable transcoding to force raw streams
        return {
            MaxStreamingBitrate: 120000000,
            MaxStaticBitrate: 120000000,
            MusicStreamingTranscodingBitrate: 320000,
            DirectPlayProfiles: [
                { Type: 'Video', Container: 'mp4,m4v,webm,mkv,avi,ts,mpegts,m2ts,wmv,asf,3gp,mov,flv' },
                { Type: 'Audio', Container: 'mp3,aac,flac,alac,opus,ogg,oga,wav,wma' },
                { Type: 'Video', Container: 'hls' }
            ],
            TranscodingProfiles: [],
            ContainerProfiles: [],
            CodecProfiles: []
        };
    }

    getDirectPlayProtocols() {
        // Encourage http direct stream from server
        return ['Http'];
    }

    async play(options) {
        this._started = false;
        this._timeUpdated = false;
        this._paused = false;
        this._prefersMSE = true;
        this._currentPlayOptions = options;
        // reset jf-rendered subtitle state
        this._customTrackIndex = -1;
        this._customSecondaryTrackIndex = -1;
        this._currentTrackEvents = null;
        this._currentSecondaryTrackEvents = null;
        this._currentTrackOffset = 0;
        this._secondaryTrackOffset = 0;
        this._destroyCustomTrack();

        await ensureAVPlayerLoaded();

        const dlg = document.querySelector('.libmediaPlayerContainer');
        if (!dlg) {
            await import('./style.scss');
            loading.show();
            const playerDlg = document.createElement('div');
            playerDlg.setAttribute('dir', 'ltr');
            playerDlg.classList.add('libmediaPlayerContainer');
            playerDlg.id = 'libmediaPlayer';
            if (options.fullscreen) {
                playerDlg.classList.add('onTop');
                document.body.classList.add('hide-scroll');
            }
            // Container for libmedia to render into
            const container = document.createElement('div');
            container.classList.add('libmediaPlayer');
            container.style.width = '100%';
            container.style.height = '100%';
            playerDlg.appendChild(container);
            document.body.insertBefore(playerDlg, document.body.firstChild);
            this._videoDialog = playerDlg;
            this._container = container;
            if (options.fullscreen && playerDlg.animate) {
                await zoomIn(playerDlg);
            }
        } else {
            if (options.fullscreen) {
                document.body.classList.add('hide-scroll');
            }
            this._videoDialog = dlg;
            this._container = dlg.querySelector('.libmediaPlayer') || dlg;
            // Ensure previous libmedia surfaces are cleared to avoid duplicate <video> when reusing container
            try { this._container.innerHTML = ''; } catch {}
        }

        const includeCorsCredentials = await getIncludeCorsCredentials();
        const httpOptions = includeCorsCredentials ? { credentials: 'include' } : undefined;

        const wasmCdn = 'https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@latest/dist';
        this._wasmBaseUrl = wasmCdn;
        /** @type {import('@libmedia/avplayer').default} */
        // eslint-disable-next-line no-undef
        this._avplayer = new window.AVPlayer({
            container: this._container,
            enableHardware: true,
            enableWebCodecs: true,
            enableWebGPU: false,
            enableWorker: true,
            wasmBaseUrl: `${wasmCdn}`,
            http: httpOptions,
            // Prefer MSE; libmedia will attach to a <video> internally when possible
            checkUseMES: () => true,
            getWasm: (type, codecId /*, mediaType */) => {
                const suffix = '';
                if (type === 'decoder') {
                    switch (codecId) {
                        case 2: return `${wasmCdn}/decode/mpeg2video${suffix}.wasm`;
                        case 12: return `${wasmCdn}/decode/mpeg4${suffix}.wasm`;
                        case 27: return `${wasmCdn}/decode/h264${suffix}.wasm`;
                        case 30: return `${wasmCdn}/decode/theora${suffix}.wasm`;
                        case 139: return `${wasmCdn}/decode/vp8${suffix}.wasm`;
                        case 167: return `${wasmCdn}/decode/vp9${suffix}.wasm`;
                        case 173: return `${wasmCdn}/decode/hevc${suffix}.wasm`;
                        case 196: return `${wasmCdn}/decode/vvc${suffix}.wasm`;
                        case 225: return `${wasmCdn}/decode/av1${suffix}.wasm`;
                        case 86017: return `${wasmCdn}/decode/mp3${suffix}.wasm`;
                        case 86018: return `${wasmCdn}/decode/aac${suffix}.wasm`;
                        case 86019: return `${wasmCdn}/decode/ac3${suffix}.wasm`;
                        case 86020: return `${wasmCdn}/decode/dca${suffix}.wasm`;
                        case 86021: return `${wasmCdn}/decode/vorbis${suffix}.wasm`;
                        case 86022: return `${wasmCdn}/decode/dvaudio${suffix}.wasm`;
                        case 86024: return `${wasmCdn}/decode/wma${suffix}.wasm`;
                        case 86028: return `${wasmCdn}/decode/flac${suffix}.wasm`;
                        case 86051: return `${wasmCdn}/decode/speex${suffix}.wasm`;
                        case 86056: return `${wasmCdn}/decode/eac3${suffix}.wasm`;
                        case 86076: return `${wasmCdn}/decode/opus${suffix}.wasm`;
                        case 7: return `${wasmCdn}/decode/mjpeg${suffix}.wasm`;
                        default: return null;
                    }
                } else if (type === 'resampler') {
                    return `${wasmCdn}/resample/resample${suffix}.wasm`;
                } else if (type === 'stretchpitcher') {
                    return `${wasmCdn}/stretchpitch/stretchpitch${suffix}.wasm`;
                }
                return null;
            }
        });

        const url = this._computeUrl(options);
        this._currentSrc = url;
        this._httpOptions = httpOptions;
        this._playlist = options.items || [];
        this._playlistIndex = options.startIndex || 0;
        // Ensure subtitle DeliveryUrl are absolute/filled to avoid apiClient.getUrl errors later
        try { this._ensureSubtitleDeliveryUrls(options); } catch {}

        // Bridge libmedia events to Jellyfin events
        this._bindEvents(options);

        try {
            // Show fetching indicator for OSD
            this.isFetching = true;
            Events.trigger(this, 'beginFetch');
            try {
                await this._avplayer.load(url, getAVPlayerLoadOptions(httpOptions));
            } catch (primaryErr) {
                // Fallback: switch to MediaStream mode (still uses <video> element via srcObject)
                console.warn('[LibmediaPlayer] MSE load failed, attempting MediaStream fallback:', primaryErr);
                try {
                    await this._switchToMediaStreamMode(url, wasmCdn, httpOptions);
                } catch (fallbackErr) {
                    console.error('[LibmediaPlayer] MediaStream fallback failed:', fallbackErr);
                    // Final fallback: force canvas pipeline (no MSE / no MediaStream)
                    try {
                        await this._forceCanvasFallback(url, wasmCdn, httpOptions);
                    } catch (canvasErr) {
                        console.error('[LibmediaPlayer] Canvas fallback failed:', canvasErr);
                        throw primaryErr;
                    }
                }
            }

            // initial volume - ensure correct range 
            this.setVolume(this._volume);


            try {
                await this._avplayer.play();
            } catch (e) {
                const name = String(e?.name || '').toLowerCase();
                if (name !== 'notallowederror' && name !== 'aborterror') {
                    throw e;
                }
            }

            // Ensure subtitles bound after initial play start as well
            try { this._reapplySubtitlesAfterPipelineChange(); } catch {}

            // Notify playback manager (self-managing) that item started
            try {
                Events.trigger(this, 'itemstarted', [options.item, options.mediaSource]);
            } catch (e) {
                // ignore
            }

            // seek to start position if requested
            const startTicks = options.playerStartPositionTicks || 0;
            if (startTicks > 0) {
                const ms = BigInt(Math.floor(startTicks / 10000));
                try {
                    await this._avplayer.seek(ms);
                } catch (err) {
                    console.warn('Initial seek failed:', err);
                }
            }

            // Auto select initial audio/subtitle per Jellyfin defaults
            try {
                const ms = options?.mediaSource;
                if (ms?.DefaultAudioStreamIndex != null) {
                    await this.setAudioStreamIndex(ms.DefaultAudioStreamIndex);
                }
                if (ms?.DefaultSubtitleStreamIndex != null) {
                    this.setSubtitleStreamIndex(ms.DefaultSubtitleStreamIndex);
                }
            } catch (error) {
                console.warn('Error setting default streams:', error);
            }

            // Show UI after playback starts.
            // IMPORTANT: Defer showVideoOsd until after playbackmanager sets current player (on playbackstart)
            const handlePlaybackStart = () => {
                try {
                    if (options.fullscreen) {
                        appRouter.showVideoOsd().then(() => {
                            this._videoDialog?.classList.remove('onTop');
                        });
                    } else {
                        setBackdropTransparency(TRANSPARENCY_LEVEL.Backdrop);
                        this._videoDialog?.classList.remove('onTop');
                    }
                } finally {
                    Events.off(this, 'playbackstart', handlePlaybackStart);
                }
            };
            Events.on(this, 'playbackstart', handlePlaybackStart);

            loading.hide();
            this.isFetching = false;
            Events.trigger(this, 'endFetch');
        } catch (err) {
            loading.hide();
            this.isFetching = false;
            Events.trigger(this, 'endFetch');
            // Signal error to playback manager
            Events.trigger(this, 'error', [err && err.message ? err.message : 'ErrorDefault']);
            throw err;
        }

        // Do not auto-tear down on browser navigation; let OSD/router manage lifecycle
    }

    async _switchToMediaStreamMode(url, wasmCdn, httpOptions) {
        // Clean current player instance if any
        try { await this._avplayer?.destroy?.(); } catch {}
        this._avplayer = null;

        // Ensure a visible render container exists inside the dialog
        if (!this._videoDialog || !document.body.contains(this._videoDialog)) {
            // Safety: recreate the whole dialog if somehow got removed
            await import('./style.scss');
            const dlg = document.createElement('div');
            dlg.setAttribute('dir', 'ltr');
            dlg.classList.add('libmediaPlayerContainer');
            dlg.id = 'libmediaPlayer';
            document.body.insertBefore(dlg, document.body.firstChild);
            this._videoDialog = dlg;
        }

        if (!this._container || !this._container.isConnected) {
            // Reuse and minimally mutate DOM to avoid breaking OSD and bindings
            const existing = this._videoDialog.querySelector('.libmediaPlayer');
            if (existing) {
                this._container = existing;
                this._container.innerHTML = '';
            } else {
                const fresh = document.createElement('div');
                fresh.classList.add('libmediaPlayer');
                fresh.style.width = '100%';
                fresh.style.height = '100%';
                this._videoDialog.appendChild(fresh);
                this._container = fresh;
            }
        } else {
            // Reattach existing container if detached
            if (!document.body.contains(this._container)) {
                this._videoDialog.appendChild(this._container);
            }
            this._container.innerHTML = '';
        }

        // Create <video> element bound to MediaStream
        const mediaStream = new MediaStream();
        const video = document.createElement('video');
        video.playsInline = true;
        video.webkitPlaysInline = true;
        video.autoplay = true;
        video.controls = false;
        video.style.width = '100%';
        video.style.height = '100%';
        video.srcObject = mediaStream;

        // Mark as libmedia-managed video for future safe cleanup
        try { video.classList.add('avplayer-video'); } catch {}
        this._container.appendChild(video);

        // Normalize HTMLVideoElement currentTime for MediaStream so it starts from 0s, not a wall-clock timestamp
        try { this._patchMediaStreamCurrentTime(video); } catch (_) {}

        // eslint-disable-next-line no-undef
        this._avplayer = new window.AVPlayer({
            container: mediaStream,
            enableHardware: true,
            enableWebCodecs: true,
            enableWebGPU: false,
            enableWorker: true,
            wasmBaseUrl: `${wasmCdn}`,
            http: httpOptions,
            checkUseMES: () => false,
            getWasm: (type, codecId) => {
                const suffix = '';
                if (type === 'decoder') {
                    switch (codecId) {
                        case 2: return `${wasmCdn}/decode/mpeg2video${suffix}.wasm`;
                        case 12: return `${wasmCdn}/decode/mpeg4${suffix}.wasm`;
                        case 27: return `${wasmCdn}/decode/h264${suffix}.wasm`;
                        case 30: return `${wasmCdn}/decode/theora${suffix}.wasm`;
                        case 139: return `${wasmCdn}/decode/vp8${suffix}.wasm`;
                        case 167: return `${wasmCdn}/decode/vp9${suffix}.wasm`;
                        case 173: return `${wasmCdn}/decode/hevc${suffix}.wasm`;
                        case 196: return `${wasmCdn}/decode/vvc${suffix}.wasm`;
                        case 225: return `${wasmCdn}/decode/av1${suffix}.wasm`;
                        case 86017: return `${wasmCdn}/decode/mp3${suffix}.wasm`;
                        case 86018: return `${wasmCdn}/decode/aac${suffix}.wasm`;
                        case 86019: return `${wasmCdn}/decode/ac3${suffix}.wasm`;
                        case 86020: return `${wasmCdn}/decode/dca${suffix}.wasm`;
                        case 86021: return `${wasmCdn}/decode/vorbis${suffix}.wasm`;
                        case 86022: return `${wasmCdn}/decode/dvaudio${suffix}.wasm`;
                        case 86024: return `${wasmCdn}/decode/wma${suffix}.wasm`;
                        case 86028: return `${wasmCdn}/decode/flac${suffix}.wasm`;
                        case 86051: return `${wasmCdn}/decode/speex${suffix}.wasm`;
                        case 86056: return `${wasmCdn}/decode/eac3${suffix}.wasm`;
                        case 86076: return `${wasmCdn}/decode/opus${suffix}.wasm`;
                        case 7: return `${wasmCdn}/decode/mjpeg${suffix}.wasm`;
                        default: return null;
                    }
                } else if (type === 'resampler') {
                    return `${wasmCdn}/resample/resample${suffix}.wasm`;
                } else if (type === 'stretchpitcher') {
                    return `${wasmCdn}/stretchpitch/stretchpitch${suffix}.wasm`;
                }
                return null;
            }
        });

        // Re-bind events to the new instance
        this._bindEvents();
        await this._avplayer.load(url, getAVPlayerLoadOptions(httpOptions));
        this._prefersMSE = false;
        // Ensure ghost video exists for canvas path before any external audio might attach
        try { this._ensureGhostVideoElement(); } catch {}
        try { await this._avplayer.play(); } catch {}
        try { this._reapplySubtitlesAfterPipelineChange(); } catch {}
    }

    async _ensureMediaStreamFallback() {
        if (!this._prefersMSE) return false;
        const posMs = (() => { try { return Number(this._avplayer?.currentTime || 0n); } catch { return 0; } })();
        await this._switchToMediaStreamMode(this._currentSrc, this._wasmBaseUrl, this._httpOptions);
        try {
            if (posMs > 0) await this._avplayer.seek(BigInt(Math.floor(posMs)));
        } catch {}
        try { await this._avplayer.play(); } catch {}
        try { this._reapplySubtitlesAfterPipelineChange(); } catch {}
        return true;
    }

    async _forceCanvasFallback(url, wasmCdn, httpOptions) {
        // Clean current player instance if any
        try { await this._avplayer?.destroy?.(); } catch {}
        this._avplayer = null;

        // Ensure container exists
        if (!this._container || !this._container.isConnected) {
            const existing = this._videoDialog?.querySelector?.('.libmediaPlayer');
            if (existing) {
                this._container = existing;
                this._container.innerHTML = '';
            } else {
                const fresh = document.createElement('div');
                fresh.classList.add('libmediaPlayer');
                fresh.style.width = '100%';
                fresh.style.height = '100%';
                this._videoDialog?.appendChild?.(fresh);
                this._container = fresh;
            }
        } else {
            this._container.innerHTML = '';
        }

        // eslint-disable-next-line no-undef
        this._avplayer = new window.AVPlayer({
            container: this._container,
            enableHardware: true,
            enableWebCodecs: true,
            enableWebGPU: false,
            enableWorker: true,
            wasmBaseUrl: `${wasmCdn}`,
            http: httpOptions,
            checkUseMES: () => false,
            getWasm: (type, codecId) => {
                const suffix = '';
                if (type === 'decoder') {
                    switch (codecId) {
                        case 2: return `${wasmCdn}/decode/mpeg2video${suffix}.wasm`;
                        case 12: return `${wasmCdn}/decode/mpeg4${suffix}.wasm`;
                        case 27: return `${wasmCdn}/decode/h264${suffix}.wasm`;
                        case 30: return `${wasmCdn}/decode/theora${suffix}.wasm`;
                        case 139: return `${wasmCdn}/decode/vp8${suffix}.wasm`;
                        case 167: return `${wasmCdn}/decode/vp9${suffix}.wasm`;
                        case 173: return `${wasmCdn}/decode/hevc${suffix}.wasm`;
                        case 196: return `${wasmCdn}/decode/vvc${suffix}.wasm`;
                        case 225: return `${wasmCdn}/decode/av1${suffix}.wasm`;
                        case 86017: return `${wasmCdn}/decode/mp3${suffix}.wasm`;
                        case 86018: return `${wasmCdn}/decode/aac${suffix}.wasm`;
                        case 86019: return `${wasmCdn}/decode/ac3${suffix}.wasm`;
                        case 86020: return `${wasmCdn}/decode/dca${suffix}.wasm`;
                        case 86021: return `${wasmCdn}/decode/vorbis${suffix}.wasm`;
                        case 86022: return `${wasmCdn}/decode/dvaudio${suffix}.wasm`;
                        case 86024: return `${wasmCdn}/decode/wma${suffix}.wasm`;
                        case 86028: return `${wasmCdn}/decode/flac${suffix}.wasm`;
                        case 86051: return `${wasmCdn}/decode/speex${suffix}.wasm`;
                        case 86056: return `${wasmCdn}/decode/eac3${suffix}.wasm`;
                        case 86076: return `${wasmCdn}/decode/opus${suffix}.wasm`;
                        case 7: return `${wasmCdn}/decode/mjpeg${suffix}.wasm`;
                        default: return null;
                    }
                } else if (type === 'resampler') {
                    return `${wasmCdn}/resample/resample${suffix}.wasm`;
                } else if (type === 'stretchpitcher') {
                    return `${wasmCdn}/stretchpitch/stretchpitch${suffix}.wasm`;
                }
                return null;
            }
        });

        this._bindEvents();
        await this._avplayer.load(url, getAVPlayerLoadOptions(httpOptions));
        this._prefersMSE = false;
        try { await this._avplayer.play(); } catch {}
        try { this._reapplySubtitlesAfterPipelineChange(); } catch {}
    }

    _reapplySubtitlesAfterPipelineChange() {
        const ms = this._currentPlayOptions?.mediaSource;
        const item = this._currentPlayOptions?.item;
        if (!ms || !item) return;
        if (this._customTrackIndex != null && this._customTrackIndex >= 0) {
            this.setSubtitleStreamIndex(this._customTrackIndex);
        } else if (ms.DefaultSubtitleStreamIndex != null && ms.DefaultSubtitleStreamIndex >= 0) {
            this.setSubtitleStreamIndex(ms.DefaultSubtitleStreamIndex);
        }
        if (this._customSecondaryTrackIndex != null && this._customSecondaryTrackIndex >= 0) {
            this.setSecondarySubtitleStreamIndex(this._customSecondaryTrackIndex);
        }
    }

    _computeUrl(options) {
        // Prefer precomputed streamInfo.url
        if (options?.url) return options.url;
        // Fallback to first item in list (sendPlaybackList path)
        const first = options?.items?.[0];
        if (first?.MediaSources?.[0]?.StreamUrl) {
            return first.MediaSources[0].StreamUrl;
        }
        if (first?.Path) return first.Path;
        // Reconstruct from item + mediaSource
        const item = options?.item;
        const mediaSource = options?.mediaSource;
        if (!item || !mediaSource) return '';
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        if (!apiClient) return '';
        // Transcoding url if any
        if (mediaSource.SupportsTranscoding && mediaSource.TranscodingUrl) {
            return apiClient.getUrl(mediaSource.TranscodingUrl);
        }
        const mediaType = (options?.mediaType || item.MediaType || '').toLowerCase();
        const prefix = mediaType === 'audio' ? 'Audio' : 'Videos';
        const container = (mediaSource.Container || 'mkv').toLowerCase();
        const directOptions = {
            Static: true,
            mediaSourceId: mediaSource.Id,
            deviceId: apiClient.deviceId(),
            ApiKey: apiClient.accessToken()
        };
        if (mediaSource.ETag) directOptions.Tag = mediaSource.ETag;
        if (mediaSource.LiveStreamId) directOptions.LiveStreamId = mediaSource.LiveStreamId;
        return apiClient.getUrl(`${prefix}/${item.Id}/stream.${container}`, directOptions);
    }

    _ensureSubtitleDeliveryUrls(options) {
        try {
            const item = options?.item;
            const mediaSource = options?.mediaSource;
            if (!item || !mediaSource) return;
            const apiClient = ServerConnections.getApiClient(item.ServerId);
            if (!apiClient) return;
            const directOptions = {
                Static: true,
                mediaSourceId: mediaSource.Id,
                deviceId: apiClient.deviceId(),
                ApiKey: apiClient.accessToken()
            };
            if (mediaSource.ETag) directOptions.Tag = mediaSource.ETag;
            if (mediaSource.LiveStreamId) directOptions.LiveStreamId = mediaSource.LiveStreamId;

            const streams = mediaSource.MediaStreams || [];
            for (const s of streams) {
                if (s.Type !== 'Subtitle') continue;
                let url = s.DeliveryUrl || '';
                if (!url || url.startsWith('/')) {
                    // Use the extension from s.Path, fallback to Codec
                    let ext = 'vtt'; // default fallback
                    if (s.Path) {
                        const pathParts = s.Path.split('.');
                        if (pathParts.length > 1) {
                            ext = pathParts[pathParts.length - 1].toLowerCase();
                        }
                    } else {
                        ext = (s.Codec || 'vtt').toLowerCase();
                    }
                    const path = `Videos/${item.Id}/${mediaSource.Id}/Subtitles/${s.Index}/stream.${ext}`;
                    url = apiClient.getUrl(path, directOptions);
                    s.DeliveryUrl = url;
                    s.IsExternalUrl = true; // mark as absolute url
                }
            }
        } catch (_) { /* ignore */ }
    }

    _bindEvents() {
        if (!this._avplayer) return;
        const ev = window.AVPlayer?.eventType || window.AVPlayer?.Events || {};
        // time updates for OSD slider
        this._avplayer.on?.(ev.TIME || 'time', () => {
            this._timeUpdated = true;
            // subtitle tick
            try {
                const timeMs = Number(this._avplayer?.currentTime || 0n);
                this._updateSubtitleText(timeMs);
            } catch {}
            // keep external audio synced to main clock
            try { this._syncExternalAudioTime(); } catch {}
            Events.trigger(this, 'timeupdate');
        });
        this._avplayer.on?.(ev.PAUSED || 'paused', () => {
            this._paused = true;
            Events.trigger(this, 'pause');
        });
        this._avplayer.on?.(ev.RESUME || 'resume', () => {
            const wasPaused = this._paused;
            this._paused = false;
            if (wasPaused) Events.trigger(this, 'unpause');
        });
        this._avplayer.on?.(ev.PLAYING || 'playing', () => {
            const wasPaused = this._paused;
            this._paused = false;
            Events.trigger(this, 'playing');
            if (wasPaused) Events.trigger(this, 'unpause');
        });
        this._avplayer.on?.(ev.PLAYED || 'played', () => {
            const wasPaused = this._paused;
            this._paused = false;
            if (wasPaused) Events.trigger(this, 'unpause');
        });
        this._avplayer.on?.(ev.LOADING || 'loading', () => {
            Events.trigger(this, 'waiting');
        });
        // Avoid early 'playing' on LOADED to prevent OSD state machine from restarting playback
        this._avplayer.on?.(ev.LOADED || 'loaded', () => {});
        this._avplayer.on?.(ev.SEEKING || 'seeking', () => {
            this._mainSeekInProgress = true;
            Events.trigger(this, 'waiting');
        });
        this._avplayer.on?.(ev.SEEKED || 'seeked', () => {
            this._mainSeekInProgress = false;
            Events.trigger(this, 'playing');
        });
        this._avplayer.on?.(ev.ENDED || 'ended', () => {
            this._onEndedInternal();
        });
        this._avplayer.on?.(ev.STOPPED || 'stopped', () => {
            this._onEndedInternal();
        });
        this._avplayer.on?.(ev.ERROR || 'error', async (err) => {
            try {
                if (this._prefersMSE && !this._inFallback) {
                    this._inFallback = true;
                    const switched = await this._ensureMediaStreamFallback();
                    this._inFallback = false;
                    if (switched) return;
                }
            } catch (_) {
                this._inFallback = false;
            }
            Events.trigger(this, 'error', [err?.message || 'ErrorDefault']);
        });
        this._avplayer.on?.(ev.STREAM_UPDATE || 'streamUpdate', () => {
            // If streams update (e.g., after fallback or dynamic probe), ensure subtitles are considered
            try { this._reapplySubtitlesAfterPipelineChange(); } catch {}
            Events.trigger(this, 'mediastreamschange');
        });
        this._avplayer.on?.(ev.VOLUME_CHANGE || 'volumeChange', () => {
            Events.trigger(this, 'volumechange');
        });
        // click passthrough for OSD
        if (this._container) {
            const onClick = () => Events.trigger(this, 'click');
            const onDblClick = () => Events.trigger(this, 'dblclick');
            this._container.addEventListener('click', onClick);
            this._container.addEventListener('dblclick', onDblClick);
            this._clickUnbind = () => {
                try { this._container.removeEventListener('click', onClick); } catch {}
                try { this._container.removeEventListener('dblclick', onDblClick); } catch {}
            };
        }
    }

    _onEndedInternal() {
        const positionMs = (() => {
            try { return Number(this._avplayer?.currentTime || 0n); } catch { return 0; }
        })();
        const stopInfo = { src: this._currentSrc };
        // Fire both forms to satisfy playbackmanager bindings
        try {
            Events.trigger(this, 'itemstopped', [{
                item: this._currentPlayOptions?.item,
                mediaSource: this._currentPlayOptions?.mediaSource,
                positionMs
            }]);
        } catch {}
        Events.trigger(this, 'stopped', [stopInfo]);
        this._currentSrc = null;
    }

    currentSrc() {
        return this._currentSrc;
    }

    // milliseconds in/out (playbackmanager expects ms)
    currentTime(val) {
        if (!this._avplayer) return 0;
        if (val != null) {
            // Convert to bigint for libmedia
            const ms = BigInt(Math.floor(val));
            this._avplayer.seek(ms).catch(err => {
                console.error('currentTime seek failed:', err);
            });
            return;
        }
        // libmedia exposes ms value as bigint, convert to number
        try {
            return Number(this._avplayer.currentTime || 0n);
        } catch {
            return 0;
        }
    }

    seekable() {
        // libmedia 走自有缓冲，允许进度条；回退到 null 让 OSD 仍可显示
        return true;
    }

    duration() {
        // Return null to let playbackmanager rely on mediaSource.RunTimeTicks
        return null;
    }

    async seek(ticks) {
        if (!this._avplayer) return Promise.reject(new Error('Player not initialized'));
        try {
            // Convert jellyfin ticks to milliseconds bigint
            const ms = BigInt(Math.floor((ticks || 0) / 10000));
            await this._avplayer.seek(ms);
            try { await this._extAudioPlayer?.seek?.(ms); } catch {}
        } catch (err) {
            console.error('Seek failed:', err);
            throw err;
        }
    }

    pause() {
        try { this._extAudioPlayer?.pause?.(); } catch {}
        return this._avplayer?.pause();
    }

    resume() {
        return this.unpause();
    }

    unpause() {
        try { this._extAudioPlayer?.play?.(); } catch {}
        return this._avplayer?.play();
    }

    playPause() {
        if (this.paused()) {
            return this.unpause();
        }
        return this.pause();
    }

    paused() {
        return !!this._paused;
    }

    volume(val) {
        if (val != null) {
            return this.setVolume(val);
        }
        return this.getVolume();
    }

    setVolume(val) {
        const clamped = Math.max(0, Math.min(100, Number(val) || 0));
        this._volume = clamped;
        htmlMediaHelper.saveVolume(clamped / 100);
        if (this._externalAudioActive) {
            if (this._extAudioElement) {
                try { this._extAudioElement.volume = clamped / 100; } catch {}
            }
            try { this._avplayer?.setVolume?.(0, true); } catch {}
        } else if (this._avplayer?.setVolume) {
            this._avplayer.setVolume(clamped / 100, true);
        }
        Events.trigger(this, 'volumechange');
    }

    getVolume() {
        return Math.max(0, Math.min(100, Number(this._volume) || 0));
    }

    setMute(mute) {
        this._muted = !!mute;
        if (this._muted) {
            this._lastVolume = this.getVolume();
            this.setVolume(0);
        } else {
            const saved = this._lastVolume != null ? this._lastVolume : (htmlMediaHelper.getSavedVolume() * 100);
            this.setVolume(saved);
        }
    }

    isMuted() {
        return this._muted;
    }

    // Stream switching — let server handle if unsupported
    canSetAudioStreamIndex() {
        return !!this._avplayer?.selectAudio;
    }

    getAudioStreamIndex() {
        try {
            const jfStreams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const streams = this._avplayer.getStreams?.() || [];
            const current = this._avplayer.selectedAudioStream || null;
            if (!current) return null;

            // Get audio streams from jellyfin (excluding external ones)
            const jfAudioStreams = jfStreams.filter((s) => s.Type === 'Audio' && !s.IsExternal)
                .sort((a, b) => a.Index - b.Index);

            // Get audio streams from libmedia
            const libAudioStreams = streams.filter((s) => {
                const codecType = s.codecpar?.codecType || s.codecparProxy?.codecType;
                return codecType === 1 || codecType === 'AVMEDIA_TYPE_AUDIO';
            });

            // Find position of current libmedia stream in libmedia audio streams
            const libStreamPosition = libAudioStreams.findIndex((s) => s.id === current.id);
            if (libStreamPosition >= 0 && libStreamPosition < jfAudioStreams.length) {
                const jfStream = jfAudioStreams[libStreamPosition];
                console.debug(`Current audio stream libmedia id ${current.id} maps to jellyfin index ${jfStream.Index}`);
                return jfStream.Index;
            }

            console.warn(`Failed to map current libmedia audio stream id ${current.id} to jellyfin index`);
            return null;
        } catch (error) {
            console.error('Error getting audio stream index:', error);
            return null;
        }
    }

    async setAudioStreamIndex(index) {
        if (!this._avplayer?.selectAudio) return;
        
        try {
            // External audio stream (m4a/mka etc.) handled via auxiliary libmedia in MediaStream mode
            const mediaSource = this._currentPlayOptions?.mediaSource;
            const item = this._currentPlayOptions?.item;
            const jfStream = (mediaSource?.MediaStreams || []).find((s) => s.Type === 'Audio' && s.Index === index);
            if (jfStream?.IsExternal) {
                await this._activateExternalAudioForStream(jfStream, item, mediaSource);
                this._extAudioSelectedIndex = index;
                return;
            } else {
                // switching back to internal
                this._deactivateExternalAudio();
                this._extAudioSelectedIndex = null;
            }

            const libId = this._mapJellyfinStreamIndexToLibId(index, 'audio');
            if (libId == null) {
                console.warn(`Failed to map jellyfin audio stream index ${index} to libmedia id`);
                return;
            }

            console.debug(`Switching to audio stream jellyfin index ${index}, libmedia id ${libId}`);
            try {
                const retryLibId = this._mapJellyfinStreamIndexToLibId(index, 'audio');
                await this._avplayer.selectAudio(retryLibId);
                console.debug(`Successfully switched to audio stream ${libId}`);
                return;
            } catch (err) {
                const msg = String(err?.message || err || '').toLowerCase();
                const notSupportMse = msg.includes('not support mse') || msg.includes('not support mes') || msg.includes('not support');
                if (!notSupportMse) throw err;
                console.warn('[LibmediaPlayer] selectAudio not supported in MSE path, attempting fallback to MediaStream');
            }

            // If we get here, try switching pipeline to MediaStream and retry
            const switched = await this._ensureMediaStreamFallback();
            if (switched) {
                try {
                    await this._avplayer.selectAudio(libId);
                    console.debug(`Successfully switched to audio stream ${libId} after fallback`);
                } catch (retryErr) {
                    console.error('Retry selectAudio after fallback failed:', retryErr);
                }
            }
        } catch (error) {
            console.error(`Error switching audio stream to index ${index}:`, error);
        }
    }

    setSubtitleStreamIndex(index) {
        // Jellyfin-rendered subtitles only. Allow rendering even without <video> (will fallback to custom element)
        const video = this._getVideoElement();
        const mediaSource = this._currentPlayOptions?.mediaSource;
        const item = this._currentPlayOptions?.item;
        if (!mediaSource || !item) return;

        // destroy when disabled (do not touch player instance)
        if (index == null || index === -1) {
            this._customTrackIndex = -1;
            this._destroyCustomTrack(0); // destroy primary
            // notify UI that only subtitle state changed
            Events.trigger(this, 'mediastreamschange');
            return;
        }

        // find track
        const track = (mediaSource.MediaStreams || []).find(t => t.Type === 'Subtitle' && t.Index === index);
        if (!track) {
            console.warn('Subtitle track not found for index', index);
            return;
        }

        this._setTrackForDisplay(video, track, item, 0);
    }

    getSubtitleStreamIndex() {
        return this._customTrackIndex == null ? -1 : this._customTrackIndex;
    }


    _mapJellyfinStreamIndexToLibId(jfIndex, kind /* 'audio' */) {
        try {
            const streams = this._avplayer.getStreams?.() || [];
            const jfStreams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const jfStream = jfStreams.find((s) => s.Index === jfIndex && (kind === 'audio' ? s.Type === 'Audio' : false));
            if (!jfStream) return null;

            // Get streams of the same type from libmedia
            const libStreams = streams.filter((s) => {
                const codecType = s.codecpar?.codecType || s.codecparProxy?.codecType;
                if (kind === 'audio') return codecType === 1 || codecType === 'AVMEDIA_TYPE_AUDIO';
                return false;
            });

            // Get jellyfin streams of the same type (excluding external ones for ordering)
            const jfStreamsOfType = jfStreams.filter((s) => s.Type === 'Audio' && !s.IsExternal).sort((a, b) => a.Index - b.Index);

            // Find the position of the target stream in jellyfin streams of the same type
            const jfStreamPosition = jfStreamsOfType.findIndex((s) => s.Index === jfIndex);
            if (jfStreamPosition >= 0 && jfStreamPosition < libStreams.length) {
                // Map by position in the same type streams
                const libStream = libStreams[jfStreamPosition];
                console.debug(`Mapped jellyfin ${kind} stream index ${jfIndex} to libmedia stream id ${libStream.id} (position ${jfStreamPosition})`);
                return libStream.id;
            }

            // Fallback: try to match by language/title heuristics
            const lang = (jfStream.Language || jfStream.lang || '').toLowerCase();
            const title = (jfStream.DisplayTitle || jfStream.Title || '').toLowerCase();
            const codec = (jfStream.Codec || '').toLowerCase();
            
            const match = libStreams.find((s) => {
                const md = s.metadata || {};
                const sLang = String(md?.LANGUAGE || md?.language || '').toLowerCase();
                const sTitle = String(md?.TITLE || md?.title || '').toLowerCase();
                
                // Try to match by language first, then title, then codec
                if (lang && sLang === lang) return true;
                if (title && sTitle === title) return true;
                if (codec && s.codecpar?.codecId && this._getCodecName(s.codecpar.codecId).toLowerCase().includes(codec)) return true;
                
                return false;
            });
            
            if (match) {
                console.debug(`Mapped jellyfin ${kind} stream index ${jfIndex} to libmedia stream id ${match.id} (by metadata)`);
                return match.id;
            }

            console.warn(`Failed to map jellyfin ${kind} stream index ${jfIndex} to libmedia stream`);
            return null;
        } catch (error) {
            console.error(`Error mapping jellyfin stream index ${jfIndex} to libmedia:`, error);
            return null;
        }
    }

    _getCodecName(codecId) {
        // Simple codec ID to name mapping for common codecs
        const codecMap = {
            86018: 'aac',
            86019: 'ac3',
            86056: 'eac3',
            86017: 'mp3',
            86028: 'flac',
            86076: 'opus',
            27: 'h264',
            173: 'hevc',
            225: 'av1'
        };
        return codecMap[codecId] || `codec_${codecId}`;
    }

    // SECONDARY SUBTITLE API (client side only)
    setSecondarySubtitleStreamIndex(index) {
        const video = this._getVideoElement();
        if (!video) return;
        const mediaSource = this._currentPlayOptions?.mediaSource;
        const item = this._currentPlayOptions?.item;
        if (!mediaSource || !item) return;
        if (index == null || index === -1) {
            this._customSecondaryTrackIndex = -1;
            this._destroyCustomTrack(1);
            return;
        }
        const track = (mediaSource.MediaStreams || []).find(t => t.Type === 'Subtitle' && t.Index === index);
        if (!track) return;
        this._setTrackForDisplay(video, track, item, 1);
    }

    // Minimal playlist management to integrate with playbackmanager when local
    getPlaylistSync() {
        return this._playlist || [];
    }

    getCurrentPlaylistIndex() {
        return this._playlistIndex || 0;
    }

    getCurrentPlaylistItemId() {
        return this._playlist?.[this._playlistIndex]?.PlaylistItemId || null;
    }

    async setCurrentPlaylistItem(playlistItemId) {
        const idx = (this._playlist || []).findIndex(p => p.PlaylistItemId === playlistItemId);
        if (idx >= 0) {
            this._playlistIndex = idx;
        }
    }

    async nextTrack() {
        if (!this._playlist?.length) return;
        const next = Math.min(this._playlistIndex + 1, this._playlist.length - 1);
        this._playlistIndex = next;
    }

    async previousTrack() {
        if (!this._playlist?.length) return;
        const prev = Math.max(this._playlistIndex - 1, 0);
        this._playlistIndex = prev;
    }

    stop(destroyPlayer) {
        const doDestroy = async () => {
            try { await this._avplayer?.stop(); } catch {}
            // Proactively emit stopped event and clear internal state to keep PlaybackManager in sync
            try { this._onEndedInternal(); } catch {}
            if (destroyPlayer) {
                try { await this._avplayer?.destroy?.(); } catch {}
                this.destroy();
            }
        };
        return doDestroy();
    }

    // Subtitles offset (seconds, client-side)
    _setSubtitleOffset(offsetSeconds) {
        const offsetValue = parseFloat(offsetSeconds) || 0;
        // ASS
        if (this._currentAssRenderer) {
            this._updateCurrentTrackOffset(offsetValue);
            this._currentAssRenderer.timeOffset = (this._currentPlayOptions?.transcodingOffsetTicks || 0) / 10000000 + offsetValue;
            return;
        }
        // PGS
        if (this._currentPgsRenderer) {
            this._updateCurrentTrackOffset(offsetValue);
            this._currentPgsRenderer.timeOffset = (this._currentPlayOptions?.transcodingOffsetTicks || 0) / 10000000 + offsetValue;
            return;
        }
        // Events based
        if (this._currentTrackEvents || this._currentSecondaryTrackEvents) {
            if (this._currentTrackEvents) this._setTrackEventsSubtitleOffset(this._currentTrackEvents, offsetValue, 0);
            if (this._currentSecondaryTrackEvents) this._setTrackEventsSubtitleOffset(this._currentSecondaryTrackEvents, offsetValue, 1);
        }
    }

    getSubtitleOffset() {
        return this._currentTrackOffset || 0;
    }

    enableShowingSubtitleOffset() {
        this._showSubtitleOffset = true;
    }

    disableShowingSubtitleOffset() {
        this._showSubtitleOffset = false;
    }

    isShowingSubtitleOffsetEnabled() {
        return !!this._showSubtitleOffset;
    }

    // Optional: buffer ranges for OSD slider
    getBufferedRanges() {
        try {
            const media = this._avplayer?.video || this._avplayer?.audio;
            const ranges = [];
            if (!media?.buffered) return ranges;
            const offset = (this._currentPlayOptions?.transcodingOffsetTicks || 0);
            for (let i = 0; i < media.buffered.length; i++) {
                const start = media.buffered.start(i);
                const end = media.buffered.end(i);
                if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                    ranges.push({ start: (start * 10000000) + offset, end: (end * 10000000) + offset });
                }
            }
            return ranges;
        } catch {
            return [];
        }
    }

    // Feature flags queried by OSD
    supports(feature) {
        switch (feature) {
            case 'PlaybackRate': return typeof this._avplayer?.getPlaybackRate === 'function';
            case 'SetAspectRatio': return true;
            case 'SetBrightness': return true;
            case 'SecondarySubtitles': return true;
            default: return false;
        }
    }

    setPlaybackRate(rate) {
        try { this._avplayer?.setPlaybackRate?.(Number(rate)); } catch {}
        try { this._extAudioPlayer?.setPlaybackRate?.(Number(rate)); } catch {}
    }

    getPlaybackRate() {
        try { return this._avplayer?.getPlaybackRate?.() ?? 1; } catch { return 1; }
    }

    // Aspect ratio mapping to CSS object-fit on container canvas
    setAspectRatio(val) {
        // Map to render mode if available, otherwise adjust canvas style
        try {
            const renderMode = window.AVPlayer?.RenderMode || { FIT: 0, FILL: 1 };
            if (this._avplayer?.setRenderMode && renderMode.FIT != null && renderMode.FILL != null) {
                if (val === 'cover') this._avplayer.setRenderMode(renderMode.FILL);
                else if (val === 'fill') this._avplayer.setRenderMode(renderMode.FILL);
                else this._avplayer.setRenderMode(renderMode.FIT);
                return;
            }
        } catch {}
        // Fallback: CSS
        if (this._container) {
            const canvas = this._container.querySelector('canvas');
            if (canvas) {
                if (val === 'auto') canvas.style.removeProperty('object-fit');
                else canvas.style.objectFit = val;
            }
        }
        const video = this._container.querySelector('video');
        if (video) {
            if (val === 'auto') video.style.removeProperty('object-fit');
            else video.style.objectFit = val;
        }
    }

    getSupportedAspectRatios() {
        return [
            { name: 'Auto', id: 'auto' },
            { name: 'AspectRatioCover', id: 'cover' },
            { name: 'AspectRatioFill', id: 'fill' }
        ];
    }

    getAspectRatio() {
        return this._aspectRatio || 'auto';
    }

    // Brightness via CSS filter on underlying video/canvas
    setBrightness(val) {
        const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n)));
        const value = clamp(val, 0, 100);
        this._brightnessValue = value;
        const target = this._resolveRenderElement();
        if (target) {
            const cssValue = value >= 100 ? 'none' : (Math.max(20, value) / 100);
            target.style.webkitFilter = cssValue === 'none' ? '' : `brightness(${cssValue})`;
            target.style.filter = cssValue === 'none' ? '' : `brightness(${cssValue})`;
        }
        Events.trigger(this, 'brightnesschange');
    }

    getBrightness() {
        return this._brightnessValue == null ? 100 : this._brightnessValue;
    }

    _resolveRenderElement() {
        // Prefer video element if available
        if (this._avplayer?.video) return this._avplayer.video;
        if (this._container) {
            const video = this._container.querySelector('video');
            if (video) return video;
            const canvas = this._container.querySelector('canvas');
            if (canvas) return canvas;
        }
        return null;
    }

    getSupportedPlaybackRates() {
        return [
            { name: '0.5x', id: 0.5 },
            { name: '0.75x', id: 0.75 },
            { name: '1x', id: 1.0 },
            { name: '1.25x', id: 1.25 },
            { name: '1.5x', id: 1.5 },
            { name: '1.75x', id: 1.75 },
            { name: '2x', id: 2.0 }
        ];
    }
    
    destroy() {
        setBackdropTransparency(TRANSPARENCY_LEVEL.None);
        document.body.classList.remove('hide-scroll');
        // Unbind popstate handler if any
        if (this._boundPopState) {
            try { window.removeEventListener('popstate', this._boundPopState); } catch {}
            this._boundPopState = null;
        }
        if (this._clickUnbind) {
            try { this._clickUnbind(); } catch {}
            this._clickUnbind = null;
        }
        this._destroyCustomTrack();
        this._destroyGhostVideoElement();
        if (this._pgsCustomCanvas) { tryRemoveElement(this._pgsCustomCanvas); this._pgsCustomCanvas = null; }
        // Restore any patched currentTime on MediaStream video
        try { this._unpatchMediaStreamCurrentTime(); } catch {}
        tryRemoveElement(this._videoDialog);
        this._videoDialog = null;
        this._container = null;
        // Exit fullscreen if still active
        try {
            if (Screenfull.isEnabled) {
                Screenfull.exit();
            } else if (document.webkitIsFullScreen && document.webkitCancelFullscreen) {
                document.webkitCancelFullscreen();
            }
        } catch {}
    }

    // ---- MediaStream currentTime normalization ----
    _patchMediaStreamCurrentTime(videoEl) {
        // Already patched
        if (!videoEl || this._mediaStreamVideo === videoEl) return;
        this._mediaStreamVideo = videoEl;
        const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        if (!desc || typeof desc.get !== 'function' || typeof desc.set !== 'function') return;
        this._nativeCurrentTimeGet = desc.get;
        this._nativeCurrentTimeSet = desc.set;
        this._msClockCalibrated = false;
        this._msClockOffsetSec = 0;

        // Calibrate offset against libmedia clock
        const calibrate = () => {
            try {
                const raw = Number(this._nativeCurrentTimeGet.call(videoEl) || 0);
                const expected = (() => { try { return Number(this._avplayer?.currentTime || 0n) / 1000; } catch { return 0; } })();
                // Only calibrate when the stream has started and raw clearly deviates from expected
                const diff = raw - expected;
                // If diff looks like a wall-clock value (e.g., seconds since epoch), or we've not calibrated yet, set/adjust offset
                if (!this._msClockCalibrated || Math.abs(diff - this._msClockOffsetSec) > 2) {
                    this._msClockOffsetSec = diff;
                    this._msClockCalibrated = true;
                }
            } catch {}
        };

        // Replace currentTime accessor on this instance only
        Object.defineProperty(videoEl, 'currentTime', {
            configurable: true,
            enumerable: false,
            get: () => {
                // Keep calibration lightweight and resilient
                calibrate();
                const raw = Number(this._nativeCurrentTimeGet.call(videoEl) || 0);
                const corrected = raw - (this._msClockOffsetSec || 0);
                return Number.isFinite(corrected) ? corrected : 0;
            },
            set: (val) => {
                const v = Number(val) || 0;
                // Map desired timeline time to raw timeline
                const rawTarget = v + (this._msClockOffsetSec || 0);
                try { this._nativeCurrentTimeSet.call(videoEl, rawTarget); } catch {}
            }
        });

        // Also recalibrate on key playback events
        const onPlay = () => calibrate();
        const onTime = () => calibrate();
        try {
            videoEl.addEventListener('playing', onPlay);
            videoEl.addEventListener('timeupdate', onTime);
        } catch {}
        this._unpatchBind = () => {
            try { videoEl.removeEventListener('playing', onPlay); } catch {}
            try { videoEl.removeEventListener('timeupdate', onTime); } catch {}
            try { delete videoEl.currentTime; } catch {}
        };
    }

    _unpatchMediaStreamCurrentTime() {
        const videoEl = this._mediaStreamVideo;
        if (!videoEl) return;
        try { this._unpatchBind?.(); } catch {}
        this._mediaStreamVideo = null;
        this._nativeCurrentTimeGet = null;
        this._nativeCurrentTimeSet = null;
        this._msClockCalibrated = false;
        this._msClockOffsetSec = 0;
        this._unpatchBind = null;
    }

    // Normalize HTMLAudioElement currentTime for aux MediaStream to reflect aux libmedia clock
    _patchAuxAudioElementCurrentTime(audioEl) {
        if (!audioEl) return;
        try {
            const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
            const self = this;
            Object.defineProperty(audioEl, 'currentTime', {
                configurable: true,
                enumerable: false,
                get() {
                    try { return Number(self._extAudioPlayer?.currentTime || 0n) / 1000; } catch { return 0; }
                },
                set(val) {
                    try {
                        const targetMs = Math.max(0, Math.floor(Number(val || 0) * 1000));
                        self._extAudioPlayer?.seek?.(BigInt(targetMs));
                    } catch {}
                }
            });
            // store unpatcher
            audioEl.__auxUnpatch = () => { try { if (desc) Object.defineProperty(audioEl, 'currentTime', desc); } catch {} };
        } catch {}
    }

    // ----- Ghost video for canvas path to drive libass/libpgs -----
    _ensureGhostVideoElement() {
        if (this._ghostVideo && document.body.contains(this._ghostVideo)) return this._ghostVideo;
        const host = this._videoDialog || document.body;
        if (!host) throw new Error('No host for ghost video');
        const ghost = document.createElement('video');
        ghost.classList.add('libmedia-ghost-video');
        ghost.playsInline = true;
        ghost.webkitPlaysInline = true;
        ghost.muted = true;
        ghost.autoplay = false;
        ghost.controls = false;
        ghost.style.position = 'absolute';
        ghost.style.inset = '0';
        ghost.style.width = '100%';
        ghost.style.height = '100%';
        ghost.style.opacity = '0';
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex = '0';
        host.appendChild(ghost);

        // Patch currentTime getter to reflect avplayer clock (seconds)
        const self = this;
        const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        try {
            Object.defineProperty(ghost, 'currentTime', {
                configurable: true,
                enumerable: false,
                get() {
                    try { return Number(self._avplayer?.currentTime || 0n) / 1000; } catch { return 0; }
                },
                set(val) {
                    const ms = BigInt(Math.floor(Number(val || 0) * 1000));
                    try { self._avplayer?.seek?.(ms); } catch {}
                }
            });
        } catch (_) {
            // ignore
        }

        this._ghostVideo = ghost;
        this._ghostUnpatch = () => {
            try { if (desc) Object.defineProperty(ghost, 'currentTime', desc); } catch {}
        };
        return ghost;
    }

    _destroyGhostVideoElement() {
        try { this._ghostUnpatch?.(); } catch {}
        this._ghostUnpatch = null;
        if (this._ghostVideo) {
            tryRemoveElement(this._ghostVideo);
        }
        this._ghostVideo = null;
    }

    // ----- Jellyfin subtitle rendering (client-side) -----
    resetSubtitleOffset() {
        this._currentTrackOffset = 0;
        this._secondaryTrackOffset = 0;
        this._showSubtitleOffset = false;
    }

    _isSecondaryTrack(index) {
        return index === SECONDARY_TEXT_TRACK_INDEX;
    }

    _getVideoElement() {
        if (this._avplayer?.video) return this._avplayer.video;
        if (this._container) {
            const video = this._container.querySelector('video');
            if (video) return video;
        }
        return null;
    }

    _destroyCustomRenderedTrackElements(targetTrackIndex) {
        if (targetTrackIndex === PRIMARY_TEXT_TRACK_INDEX || targetTrackIndex == null) {
            if (this._videoSubtitlesElem) { tryRemoveElement(this._videoSubtitlesElem); this._videoSubtitlesElem = null; }
        }
        if (targetTrackIndex === SECONDARY_TEXT_TRACK_INDEX || targetTrackIndex == null) {
            if (this._videoSecondarySubtitlesElem) { tryRemoveElement(this._videoSecondarySubtitlesElem); this._videoSecondarySubtitlesElem = null; }
        }
        if (targetTrackIndex == null) {
            // remove container if exists
            const container = document.querySelector('.videoSubtitles');
            if (container) tryRemoveElement(container);
        }
    }

    _destroyStoredTrackInfo(targetTrackIndex) {
        if (targetTrackIndex === PRIMARY_TEXT_TRACK_INDEX || targetTrackIndex == null) {
            this._customTrackIndex = -1;
            this._currentTrackEvents = null;
        }
        if (targetTrackIndex === SECONDARY_TEXT_TRACK_INDEX || targetTrackIndex == null) {
            this._customSecondaryTrackIndex = -1;
            this._currentSecondaryTrackEvents = null;
        }
    }

    _destroyCustomTrack(targetTrackIndex) {
        this._destroyCustomRenderedTrackElements(targetTrackIndex);
        this._destroyStoredTrackInfo(targetTrackIndex);
        const ass = this._currentAssRenderer; if (ass) { try { ass.dispose(); } catch {} }
        this._currentAssRenderer = null;
        const pgs = this._currentPgsRenderer; if (pgs) { try { pgs.dispose(); } catch {} }
        this._currentPgsRenderer = null;
    }

    _requiresCustomSubtitlesElement(/* userSettings */) {
        // Always use custom element rendering for consistent behavior
        return true;
    }

    async _fetchSubtitles(track, item) {
        const url = this._getTextTrackUrl(track, item, '.js');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch subtitles: ${res.status}`);
        return res.json();
    }

    _getTextTrackUrl(track, item, format) {
        // Always derive from Jellyfin helper to ensure server produces the correct JSON endpoint (.js)
        // Avoid using DeliveryUrl directly, which may point to raw .srt/.ass files
        let url = playbackManager.getSubtitleUrl(track, item.ServerId);
        if (format) {
            // Replace terminal extension (default .vtt) with desired format, preserving query string
            url = url.replace(/\.(vtt|srt|ass|ssa|pgssub|sub)(?=($|\?))/i, format);
            if (!/\.(js|vtt|srt|ass|ssa|pgssub|sub)(?=($|\?))/i.test(url)) {
                const qsIndex = url.indexOf('?');
                url = qsIndex >= 0 ? `${url.slice(0, qsIndex)}${format}${url.slice(qsIndex)}` : `${url}${format}`;
            }
        }
        return url;
    }

    async _setTrackForDisplay(videoElement, track, item, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        if (!track) {
            this._destroyCustomTrack(this._isSecondaryTrack(targetTextTrackIndex) ? targetTextTrackIndex : undefined);
            return;
        }
        if (this._isSecondaryTrack(targetTextTrackIndex)) {
            if (this._customSecondaryTrackIndex === track.Index) return;
        } else if (this._customTrackIndex === track.Index) return;

        this.resetSubtitleOffset();
        this._destroyCustomTrack(targetTextTrackIndex);
        if (this._isSecondaryTrack(targetTextTrackIndex)) this._customSecondaryTrackIndex = track.Index; else this._customTrackIndex = track.Index;

        const format = (track.Codec || '').toLowerCase();
        if (format === 'ssa' || format === 'ass') {
            await this._renderSsaAss(videoElement, track, item);
            return;
        }
        if (format === 'pgssub') {
            await this._renderPgs(videoElement, track, item);
            return;
        }
        // default: fetch JSON and render custom element
        await this._renderSubtitlesWithCustomElement(videoElement, track, item, targetTextTrackIndex);
    }

    async _renderSsaAss(videoElement, track, item) {
        // If no HTMLVideoElement (e.g. canvas path), create a ghost video to drive libass
        if (!videoElement) {
            try {
                videoElement = this._ensureGhostVideoElement();
            } catch (_) {
                await this._renderSubtitlesWithCustomElement(null, track, item, PRIMARY_TEXT_TRACK_INDEX);
                return;
            }
        }
        const supportedFonts = ['application/vnd.ms-opentype', 'application/x-truetype-font', 'font/otf', 'font/ttf', 'font/woff', 'font/woff2'];
        const availableFonts = [];
        const attachments = this._currentPlayOptions?.mediaSource?.MediaAttachments || [];
        const apiClient = ServerConnections.getApiClient(item);
        attachments.forEach(i => {
            if (supportedFonts.includes(i.MimeType)) {
                availableFonts.push(apiClient.getUrl(i.DeliveryUrl));
            }
        });
        const fallbackFontList = apiClient.getUrl('/FallbackFont/Fonts', { ApiKey: apiClient.accessToken() });
        const wasmImport = await import('@jellyfin/libass-wasm');
        const SubtitlesOctopus = wasmImport.default;
        const mediaSource = this._currentPlayOptions?.mediaSource;
        const videoStream = (mediaSource?.MediaStreams || []).find(s => s.Type === 'Video');
        const options = {
            video: videoElement,
            subUrl: this._getTextTrackUrl(track, item),
            fonts: availableFonts,
            workerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker.js`,
            legacyWorkerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker-legacy.js`,
            onError: () => {
                this._currentAssRenderer = null;
            },
            timeOffset: (this._currentPlayOptions?.transcodingOffsetTicks || 0) / 10000000,
            renderMode: 'wasm-blend',
            dropAllAnimations: false,
            libassMemoryLimit: 40,
            libassGlyphLimit: 40,
            targetFps: videoStream?.ReferenceFrameRate || videoStream?.RealFrameRate || 24,
            prescaleFactor: 0.8,
            prescaleHeightLimit: 1080,
            maxRenderHeight: 2160,
            resizeVariation: 0.2,
            renderAhead: 90
        };
        const [config, workerUrl, legacyWorkerUrl] = await Promise.all([
            apiClient.getNamedConfiguration('encoding'), resolveUrl(options.workerUrl), resolveUrl(options.legacyWorkerUrl)
        ]);
        options.workerUrl = workerUrl;
        options.legacyWorkerUrl = legacyWorkerUrl;
        if (config.EnableFallbackFont) {
            const fontFiles = await apiClient.getJSON(fallbackFontList);
            (fontFiles || []).forEach(font => {
                const fontUrl = apiClient.getUrl(`/FallbackFont/Fonts/${encodeURIComponent(font.Name)}`, { ApiKey: apiClient.accessToken() });
                availableFonts.push(fontUrl);
            });
        }
        this._currentAssRenderer = new SubtitlesOctopus(options);
    }

    async _renderPgs(videoElement, track, item) {
        const libpgs = await import('libpgs');
        // Ensure video/canvas target
        let targetVideo = videoElement;
        if (!targetVideo) {
            try {
                targetVideo = this._ensureGhostVideoElement();
            } catch (e) {
                // fallback to canvas overlay if ghost video cannot be created
                const canvas = document.createElement('canvas');
                canvas.style.position = 'absolute';
                canvas.style.inset = '0';
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                canvas.style.pointerEvents = 'none';
                this._container?.appendChild(canvas);
                this._pgsCustomCanvas = canvas;
                const aspectRatio = this.getAspectRatio() === 'auto' ? 'contain' : this.getAspectRatio();
                const options = {
                    canvas,
                    subUrl: this._getTextTrackUrl(track, item),
                    workerUrl: `${appRouter.baseUrl()}/libraries/libpgs.worker.js`,
                    timeOffset: (this._currentPlayOptions?.transcodingOffsetTicks || 0) / 10000000,
                    aspectRatio
                };
                this._currentPgsRenderer = new libpgs.PgsRenderer(options);
                return;
            }
        }
        const aspectRatio = this.getAspectRatio() === 'auto' ? 'contain' : this.getAspectRatio();
        const options = {
            video: targetVideo,
            subUrl: this._getTextTrackUrl(track, item),
            workerUrl: `${appRouter.baseUrl()}/libraries/libpgs.worker.js`,
            timeOffset: (this._currentPlayOptions?.transcodingOffsetTicks || 0) / 10000000,
            aspectRatio
        };
        this._currentPgsRenderer = new libpgs.PgsRenderer(options);
    }

    async _renderSubtitlesWithCustomElement(videoElement, track, item, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        const [userSettings, subtitleData] = await Promise.all([
            import('../../scripts/settings/userSettings'), this._fetchSubtitles(track, item)
        ]);
        const { currentSettings } = userSettings;
        const subtitleAppearance = currentSettings.getSubtitleAppearanceSettings();
        const subtitleVerticalPosition = parseInt(subtitleAppearance.verticalPosition, 10);

        if (!this._videoSubtitlesElem && !this._isSecondaryTrack(targetTextTrackIndex)) {
            let container = document.querySelector('.videoSubtitles');
            if (!container) {
                container = document.createElement('div');
                container.classList.add('videoSubtitles');
                (this._videoDialog || document.body).appendChild(container);
            }
            const inner = document.createElement('div');
            inner.classList.add('videoSubtitlesInner');
            container.appendChild(inner);
            this._videoSubtitlesElem = inner;
            await this._setSubtitleAppearance(container, inner);
            this._currentTrackEvents = subtitleData.TrackEvents;
        } else if (!this._videoSecondarySubtitlesElem && this._isSecondaryTrack(targetTextTrackIndex)) {
            const container = document.querySelector('.videoSubtitles');
            if (!container) return;
            const inner = document.createElement('div');
            inner.classList.add('videoSecondarySubtitlesInner');
            if (subtitleVerticalPosition < 0) container.insertBefore(inner, container.firstChild);
            else container.appendChild(inner);
            this._videoSecondarySubtitlesElem = inner;
            await this._setSubtitleAppearance(container, inner);
            this._currentSecondaryTrackEvents = subtitleData.TrackEvents;
        }
    }

    async _setSubtitleAppearance(container, inner) {
        const [userSettings, subtitleAppearanceHelper] = await Promise.all([
            import('../../scripts/settings/userSettings'), import('../../components/subtitlesettings/subtitleappearancehelper')
        ]);
        subtitleAppearanceHelper.applyStyles({ text: inner, window: container }, userSettings.getSubtitleAppearanceSettings());
    }

    _updateSubtitleText(timeMs) {
        const allTrackEvents = [this._currentTrackEvents, this._currentSecondaryTrackEvents];
        const subtitleTextElements = [this._videoSubtitlesElem, this._videoSecondarySubtitlesElem];
        for (let i = 0; i < allTrackEvents.length; i++) {
            const trackEvents = allTrackEvents[i];
            const subtitleTextElement = subtitleTextElements[i];
            if (trackEvents && subtitleTextElement) {
                const ticks = timeMs * 10000 + (this._currentPlayOptions?.transcodingOffsetTicks || 0);
                let selectedTrackEvent;
                for (const trackEvent of trackEvents) {
                    if (trackEvent.StartPositionTicks <= ticks && trackEvent.EndPositionTicks >= ticks) {
                        selectedTrackEvent = trackEvent; break;
                    }
                }
                if (selectedTrackEvent?.Text) {
                    subtitleTextElement.innerHTML = DOMPurify.sanitize(normalizeTrackEventText(selectedTrackEvent.Text, true));
                    subtitleTextElement.classList.remove('hide');
                } else {
                    subtitleTextElement.classList.add('hide');
                }
            }
        }
    }

    _setTrackEventsSubtitleOffset(trackEvents, offsetValue, currentTrackIndex) {
        if (Array.isArray(trackEvents)) {
            const relative = this._updateCurrentTrackOffset(offsetValue, currentTrackIndex) * 1e7; // ticks
            if (relative === 0) return;
            trackEvents.forEach((trackEvent) => {
                trackEvent.StartPositionTicks -= relative;
                trackEvent.EndPositionTicks -= relative;
            });
        }
    }

    _updateCurrentTrackOffset(offsetValue, currentTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        let offsetToCompare = this._currentTrackOffset;
        if (this._isSecondaryTrack(currentTrackIndex)) offsetToCompare = this._secondaryTrackOffset;
        let relativeOffset = offsetValue;
        const newTrackOffset = offsetValue;
        if (offsetToCompare) relativeOffset -= offsetToCompare;
        if (this._isSecondaryTrack(currentTrackIndex)) this._secondaryTrackOffset = newTrackOffset; else this._currentTrackOffset = newTrackOffset;
        return relativeOffset;
    }

    // Fullscreen helpers for OSD controls
    isFullscreen() {
        if (Screenfull.isEnabled) return Screenfull.isFullscreen;
        // iOS Safari
        return document.webkitIsFullScreen || false;
    }

    toggleFullscreen() {
        if (Screenfull.isEnabled) {
            Screenfull.toggle();
            return;
        }
        // iOS Safari fallback
        const el = document.documentElement;
        if (!document.webkitIsFullScreen && el.webkitRequestFullscreen) {
            el.webkitRequestFullscreen();
        } else if (document.webkitIsFullScreen && document.webkitCancelFullscreen) {
            document.webkitCancelFullscreen();
        }
    }
}

export default LibmediaPlayer;


// ---------------------
// Jellyfin subtitle rendering helpers (ported/minimized from HtmlVideoPlayer)
// ---------------------

// Primary = 0, Secondary = 1
const PRIMARY_TEXT_TRACK_INDEX = 0;
const SECONDARY_TEXT_TRACK_INDEX = 1;

function normalizeTrackEventText(text, useHtml) {
    const result = (text || '')
        .replace(/\\N/gi, '\n')
        .replace(/\r/gi, '')
        .replace(/\{\\.*?\}/gi, '')
        .split('\n').map(val => `\u200E${val}`).join('\n');
    return useHtml ? result.replace(/\n/gi, '<br>') : result;
}

// ---------------------
// External audio helpers (prototype methods)
// ---------------------
LibmediaPlayer.prototype._computeExternalAudioUrl = function (track, item, mediaSource) {
    try {
        if (!track || !item || !mediaSource) return '';
        let delivery = track.DeliveryUrl;
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        const directOptions = {
            Static: true,
            mediaSourceId: mediaSource.Id,
            deviceId: apiClient.deviceId(),
            ApiKey: apiClient.accessToken()
        };
        if (mediaSource.ETag) directOptions.Tag = mediaSource.ETag;
        if (mediaSource.LiveStreamId) directOptions.LiveStreamId = mediaSource.LiveStreamId;
        if (!delivery || delivery.startsWith('/')) {
            // Use the extension from track.Path, fallback to Container/Codec
            let ext = 'aac'; // default fallback
            if (track.Path) {
                const pathParts = track.Path.split('.');
                if (pathParts.length > 1) {
                    ext = pathParts[pathParts.length - 1].toLowerCase();
                }
            } else {
                ext = (track.Container || track.Codec || 'aac').toLowerCase();
            }
            const path = `Videos/${item.Id}/${mediaSource.Id}/Audios/${track.Index}/stream.${ext}`;
            delivery = apiClient.getUrl(path, directOptions);
        }
        return delivery;
    } catch { return ''; }
};

LibmediaPlayer.prototype._activateExternalAudioForStream = async function (track, item, mediaSource) {
    try {
        if (this._externalAudioActive && this._extAudioSelectedIndex === track?.Index) return;
        this._deactivateExternalAudio();
        const url = this._computeExternalAudioUrl(track, item, mediaSource);
        if (!url) throw new Error('External audio url not available');

        // Ensure a ghost video exists as the master clock for any canvas path
        try { this._ensureGhostVideoElement(); } catch {}

        // Create hidden audio element bound to MediaStream
        const audioStream = new MediaStream();
        const audioElem = document.createElement('audio');
        audioElem.autoplay = true;
        audioElem.controls = false;
        audioElem.muted = false;
        audioElem.playsInline = true;
        audioElem.webkitPlaysInline = true;
        audioElem.style.position = 'absolute';
        audioElem.style.inset = '0';
        audioElem.style.opacity = '0';
        audioElem.style.pointerEvents = 'none';
        audioElem.srcObject = audioStream;
        (this._videoDialog || document.body).appendChild(audioElem);
        // Patch audio currentTime to proxy aux libmedia clock (for debugging and external queries)
        try { this._patchAuxAudioElementCurrentTime(audioElem); } catch {}

        const wasmCdn = this._wasmBaseUrl || 'https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@latest/dist';
        // eslint-disable-next-line no-undef
        const aux = new window.AVPlayer({
            container: audioStream,
            enableHardware: true,
            enableWebCodecs: true,
            enableWebGPU: false,
            enableWorker: true,
            wasmBaseUrl: `${wasmCdn}`,
            http: this._httpOptions,
            checkUseMES: () => false,
            getWasm: (type, codecId) => {
                const suffix = '';
                if (type === 'decoder') {
                    switch (codecId) {
                        case 86017: return `${wasmCdn}/decode/mp3${suffix}.wasm`;
                        case 86018: return `${wasmCdn}/decode/aac${suffix}.wasm`;
                        case 86019: return `${wasmCdn}/decode/ac3${suffix}.wasm`;
                        case 86020: return `${wasmCdn}/decode/dca${suffix}.wasm`;
                        case 86021: return `${wasmCdn}/decode/vorbis${suffix}.wasm`;
                        case 86024: return `${wasmCdn}/decode/wma${suffix}.wasm`;
                        case 86028: return `${wasmCdn}/decode/flac${suffix}.wasm`;
                        case 86051: return `${wasmCdn}/decode/speex${suffix}.wasm`;
                        case 86056: return `${wasmCdn}/decode/eac3${suffix}.wasm`;
                        case 86076: return `${wasmCdn}/decode/opus${suffix}.wasm`;
                        default: return null;
                    }
                } else if (type === 'resampler') {
                    return `${wasmCdn}/resample/resample${suffix}.wasm`;
                } else if (type === 'stretchpitcher') {
                    return `${wasmCdn}/stretchpitch/stretchpitch${suffix}.wasm`;
                }
                return null;
            }
        });

        // Reset sync flags and bind aux events to guard resync logic
        try {
            const ev = window.AVPlayer?.eventType || window.AVPlayer?.Events || {};
            this._extAudioPrimed = false;
            this._extAudioSeekInProgress = false;
            this._extAudioLastResyncTs = 0;
            this._extAudioStreamIndex = -1; // Track the audio stream index for correct seeking
            
            aux.on?.(ev.SEEKING || 'seeking', () => { this._extAudioSeekInProgress = true; });
            aux.on?.(ev.SEEKED || 'seeked', () => { this._extAudioSeekInProgress = false; this._extAudioLastResyncTs = performance.now ? performance.now() : Date.now(); });
            aux.on?.(ev.LOADED || 'loaded', () => {
                // Get the audio stream index after loading for correct seeking
                try {
                    const streams = aux.getStreams?.() || [];
                    const audioStream = streams.find(s => s.codecpar?.codecType === 1); // AVMEDIA_TYPE_AUDIO = 1
                    if (audioStream) {
                        this._extAudioStreamIndex = audioStream.index;
                    }
                } catch {}
            });
            aux.on?.(ev.PLAYING || 'playing', () => {
                this._extAudioPrimed = true;
                // Apply current playback rate but avoid immediate seek on first play
                try { const r = this.getPlaybackRate?.() ?? 1; aux.setPlaybackRate?.(Number(r)); } catch {}
                this._extAudioLastResyncTs = performance.now ? performance.now() : Date.now();
            });
        } catch {}

        await aux.load(url, getAVPlayerLoadOptions(this._httpOptions));
        try { await aux.play(); } catch {}

        try { this._avplayer?.setVolume?.(0, true); this._mutedMainDueToExternal = true; } catch {}
        try { audioElem.volume = (this._volume || 100) / 100; } catch {}

        this._extAudioElement = audioElem;
        this._extAudioStream = audioStream;
        this._extAudioPlayer = aux;
        this._externalAudioActive = true;
        this._extAudioSelectedIndex = track?.Index ?? null;
        try { const r = this.getPlaybackRate?.() ?? 1; aux.setPlaybackRate?.(Number(r)); } catch {}
    } catch (err) {
        console.warn('Failed to activate external audio:', err);
        this._deactivateExternalAudio();
    }
};

LibmediaPlayer.prototype._deactivateExternalAudio = function () {
    try { this._extAudioPlayer?.stop?.(); } catch {}
    try { this._extAudioPlayer?.destroy?.(); } catch {}
    this._extAudioPlayer = null;
    this._extAudioStream = null;
    if (this._extAudioElement) { tryRemoveElement(this._extAudioElement); }
    this._extAudioElement = null;
    if (this._mutedMainDueToExternal) {
        try { this._avplayer?.setVolume?.((this._volume || 0) / 100, true); } catch {}
        this._mutedMainDueToExternal = false;
    }
    this._externalAudioActive = false;
    this._extAudioSelectedIndex = null;
};

LibmediaPlayer.prototype._syncExternalAudioTime = function () {
    if (!this._externalAudioActive || !this._extAudioPlayer || !this._avplayer) return;
    try {
        // If seek is ongoing (main or aux), defer resync to avoid chase oscillation
        if (this._mainSeekInProgress || this._extAudioSeekInProgress || !this._extAudioPrimed) return;
        const mainMs = Number(this._avplayer.currentTime || 0n);
        const auxMs = Number(this._extAudioPlayer.currentTime || 0n);
        const drift = (auxMs - mainMs) / 1000;
        const now = performance.now ? performance.now() : Date.now();
        // Rate-limit resyncs to avoid rapid reseek loops
        if (this._extAudioLastResyncTs && (now - this._extAudioLastResyncTs) < 500) return;
        // Only sync if drift is significant and we have the correct stream index
        if (Math.abs(drift) > 0.2 && this._extAudioStreamIndex >= 0) {
            this._extAudioSeekInProgress = true;
            // Use doSeek with correct streamIndex and AVSeekFlags.FRAME for frame-accurate seeking
            try {
                const targetMs = Math.max(0, mainMs);
                // Call doSeek directly with streamIndex - this is the correct way for libmedia
                this._extAudioPlayer.doSeek?.(BigInt(targetMs), this._extAudioStreamIndex);
            } catch {
                // Fallback to simple seek if doSeek is not available
                this._extAudioPlayer.seek?.(BigInt(Math.max(0, mainMs)));
            }
            this._extAudioLastResyncTs = now;
        }
    } catch {}
};
