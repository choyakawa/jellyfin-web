import Screenfull from 'screenfull';

import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import loading from '../../components/loading/loading';
import { appRouter } from '../../components/router/appRouter';
import { setBackdropTransparency, TRANSPARENCY_LEVEL } from '../../components/backdrop/backdrop';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import * as htmlMediaHelper from '../../components/htmlMediaHelper';
import { ServerConnections } from 'lib/jellyfin-apiclient';

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
    if (window.AVPlayer) return;
    // Prefer ESM to avoid import.meta errors in UMD on some setups
    try {
        // eslint-disable-next-line import/no-dynamic-require
        const mod = await (0, eval)('import(/**/ /* webpackIgnore: true */ "libraries/libmedia/esm/avplayer.js")');
        if (mod?.default) {
            window.AVPlayer = mod.default;
            return;
        }
    } catch (_) { /* ignore */ }
    try {
        const mod = await (0, eval)('import(/**/ /* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/@libmedia/avplayer/dist/esm/avplayer.js")');
        if (mod?.default) {
            window.AVPlayer = mod.default;
            return;
        }
    } catch (_) { /* ignore */ }
    // Final fallback to UMD if ESM unavailable
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'libraries/libmedia/avplayer.js';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = (e) => reject(e);
        document.head.appendChild(script);
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
        // Take priority over HTML players (which default to 1)
        this.priority = 0;
        // Let playbackmanager expand DeliveryUrl to absolute
        this.useFullSubtitleUrls = true;
        this.isLocalPlayer = true;
        this._currentSrc = null;
        this._volume = htmlMediaHelper.getSavedVolume();
        this._muted = false;
        this._playlist = [];
        this._playlistIndex = 0;
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
        }

        const includeCorsCredentials = await getIncludeCorsCredentials();
        const httpOptions = includeCorsCredentials ? { credentials: 'include' } : undefined;

        const wasmCdn = 'https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@latest/dist';

        /** @type {import('@libmedia/avplayer').default} */
        // eslint-disable-next-line no-undef
        this._avplayer = new window.AVPlayer({
            container: this._container,
            enableHardware: true,
            enableWorker: true,
            wasmBaseUrl: `${wasmCdn}`,
            http: httpOptions,
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
        this._playlist = options.items || [];
        this._playlistIndex = options.startIndex || 0;

        // Bridge libmedia events to Jellyfin events
        this._bindEvents(options);

        try {
            await this._avplayer.load(url);

            // initial volume
            this.setVolume(this._volume);

            // Load external subtitles if present
            const extTracks = options?.textTracks || options?.tracks || [];
            for (const t of extTracks) {
                if (t.DeliveryMethod === 'External' && t.DeliveryUrl) {
                    try {
                        await this._avplayer.loadExternalSubtitle({ source: t.DeliveryUrl, title: t.DisplayTitle, lang: t.Language });
                    } catch (e) {
                        console.warn('loadExternalSubtitle failed', e);
                    }
                }
            }

            try {
                await this._avplayer.play();
            } catch (e) {
                const name = String(e?.name || '').toLowerCase();
                if (name !== 'notallowederror' && name !== 'aborterror') {
                    throw e;
                }
            }

            // seek to start position if requested
            const startTicks = options.playerStartPositionTicks || 0;
            if (startTicks > 0) {
                const ms = Math.floor(startTicks / 10000);
                await this._avplayer.seek(ms);
            }

            // Show UI after playback starts
            if (options.fullscreen) {
                await appRouter.showVideoOsd();
                this._videoDialog.classList.remove('onTop');
            } else {
                setBackdropTransparency(TRANSPARENCY_LEVEL.Backdrop);
                this._videoDialog.classList.remove('onTop');
            }

            loading.hide();
        } catch (err) {
            loading.hide();
            // Signal error to playback manager
            Events.trigger(this, 'error', [err && err.message ? err.message : 'ErrorDefault']);
            throw err;
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

    _bindEvents() {
        if (!this._avplayer) return;
        // eslint-disable-next-line no-undef
        const ev = window.AVPlayer?.eventType || {};
        this._avplayer.on?.('time', () => {
            this._timeUpdated = true;
            Events.trigger(this, 'timeupdate');
        });
        this._avplayer.on?.('paused', () => {
            this._paused = true;
            Events.trigger(this, 'pause');
        });
        this._avplayer.on?.('resume', () => {
            this._paused = false;
            Events.trigger(this, 'unpause');
        });
        this._avplayer.on?.('ended', () => {
            this._onEndedInternal();
        });
        this._avplayer.on?.('stopped', () => {
            this._onEndedInternal();
        });
        this._avplayer.on?.('error', (err) => {
            Events.trigger(this, 'error', [err?.message || 'ErrorDefault']);
        });
    }

    _onEndedInternal() {
        const stopInfo = { src: this._currentSrc };
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
            const ms = Math.floor(val);
            this._avplayer.seek(ms);
            return;
        }
        // libmedia exposes ms value
        try {
            // eslint-disable-next-line no-undef
            return Number(this._avplayer.currentTime || 0);
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

    seek(ticks) {
        if (!this._avplayer) return;
        const ms = Math.floor((ticks || 0) / 10000);
        return this._avplayer.seek(ms);
    }

    pause() {
        return this._avplayer?.pause();
    }

    resume() {
        return this.unpause();
    }

    unpause() {
        return this._avplayer?.play();
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
        this._volume = Math.max(0, Math.min(1, val || 0));
        htmlMediaHelper.saveVolume(this._volume);
        if (this._avplayer?.setVolume) {
            this._avplayer.setVolume(this._volume, true);
        }
        Events.trigger(this, 'volumechange');
    }

    getVolume() {
        return this._volume;
    }

    setMute(mute) {
        this._muted = !!mute;
        if (this._muted) {
            this._lastVolume = this._volume;
            this.setVolume(0);
        } else {
            this.setVolume(this._lastVolume || htmlMediaHelper.getSavedVolume());
        }
    }

    isMuted() {
        return this._muted;
    }

    // Stream switching — let server handle if unsupported
    canSetAudioStreamIndex() {
        return !!this._avplayer?.selectAudio;
    }

    setAudioStreamIndex(index) {
        if (this._avplayer?.selectAudio) {
            return this._avplayer.selectAudio(index);
        }
    }

    setSubtitleStreamIndex(index) {
        if (this._avplayer?.selectSubtitle) {
            return this._avplayer.selectSubtitle(index);
        }
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
            if (destroyPlayer) {
                try { await this._avplayer?.destroy?.(); } catch {}
                this.destroy();
            }
        };
        return doDestroy();
    }

    destroy() {
        setBackdropTransparency(TRANSPARENCY_LEVEL.None);
        document.body.classList.remove('hide-scroll');
        tryRemoveElement(this._videoDialog);
        this._videoDialog = null;
        this._container = null;
    }
}

export default LibmediaPlayer;


