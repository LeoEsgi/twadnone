twitch-videoad.js text/javascript
(function() {
    if (!/^(?:.*\.)?twitch\.tv$/.test(document.location.hostname)) { return; }

    const OPTS = {
        ROLLING_DEVICE_ID: false,
        STRIP_AD_SEGMENTS: true,
        NOTIFY_ADS_WATCHED: true,
        NOTIFY_ADS_WATCHED_MIN_REQUESTS: false,
        BACKUP_PLAYER_TYPE: 'autoplay',
        BACKUP_PLATFORM: 'ios',
        REGULAR_PLAYER_TYPE: 'site',
        ACCESS_TOKEN_PLAYER_TYPE: null,
        SHOW_AD_BANNER: true,
        AD_SIGNIFIER: 'stitched-ad',
        LIVE_SIGNIFIER: ',live',
        CLIENT_ID: 'kimne78kx3ncx6brgo4mv6wki5h1ko'
    };

    const STATE = {
        StreamInfos: [],
        StreamInfosByUrl: [],
        CurrentChannelNameFromM3U8: null,
        gql_device_id: null,
        gql_device_id_rolling: '',
        ClientIntegrityHeader: null,
        AuthorizationHeader: null
    };

    function generateRollingDeviceId() {
        const charTable = Array.from({length: 26}, (_, i) => String.fromCharCode(i + 97))
                             .concat(Array.from({length: 26}, (_, i) => String.fromCharCode(i + 65)))
                             .concat(Array.from({length: 10}, (_, i) => String.fromCharCode(i + 48)));
        const bs = 'eVI6jx47kJvCFfFowK86eVI6jx47kJvC';
        const di = new Date().getUTCFullYear() + new Date().getUTCMonth() + Math.floor(new Date().getUTCDate() / 7);
        let rollingId = '';
        for (let i = 0; i < bs.length; i++) {
            rollingId += charTable[(bs.charCodeAt(i) ^ di) % charTable.length];
        }
        return rollingId;
    }

    function declareOptions(scope) {
        Object.assign(scope, OPTS, STATE);
        scope.gql_device_id_rolling = generateRollingDeviceId();
    }

    declareOptions(window);

    const twitchWorkers = [];
    const oldWorker = window.Worker;
    window.Worker = class extends oldWorker {
        constructor(twitchBlobUrl) {
            const jsURL = getWasmWorkerUrl(twitchBlobUrl);
            if (typeof jsURL !== 'string') {
                super(twitchBlobUrl);
                return;
            }

            const newBlobStr = `
                ${processM3U8.toString()}
                ${hookWorkerFetch.toString()}
                ${declareOptions.toString()}
                ${getAccessToken.toString()}
                ${gqlRequest.toString()}
                ${makeGraphQlPacket.toString()}
                ${tryNotifyAdsWatchedM3U8.toString()}
                ${parseAttributes.toString()}
                ${onFoundAd.toString()}
                declareOptions(self);
                self.addEventListener('message', e => {
                    if (e.data.key === 'UboUpdateDeviceId') {
                        gql_device_id = e.data.value;
                    } else if (e.data.key === 'UpdateClientIntegrityHeader') {
                        ClientIntegrityHeader = e.data.value;
                    } else if (e.data.key === 'UpdateAuthorizationHeader') {
                        AuthorizationHeader = e.data.value;
                    }
                });
                hookWorkerFetch();
                importScripts('${jsURL}');
            `;

            super(URL.createObjectURL(new Blob([newBlobStr])));
            twitchWorkers.push(this);
            this.onmessage = function(e) {
                const adDiv = getAdDiv();
                switch (e.data.key) {
                    case 'UboShowAdBanner':
                        if (adDiv) {
                            adDiv.P.textContent = `Blocking${e.data.isMidroll ? ' midroll' : ''} ads`;
                            if (OPTS.SHOW_AD_BANNER) {
                                adDiv.style.display = 'block';
                            }
                        }
                        break;
                    case 'UboHideAdBanner':
                        if (adDiv) adDiv.style.display = 'none';
                        break;
                    case 'UboReloadPlayer':
                        reloadTwitchPlayer();
                        break;
                    case 'UboPauseResumePlayer':
                        reloadTwitchPlayer(false, true);
                        break;
                    case 'UboSeekPlayer':
                        reloadTwitchPlayer(true);
                        break;
                }
            };
        }
    };

    function getWasmWorkerUrl(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.send();
        return req.responseText.split("'")[1];
    }

    function onFoundAd(streamInfo, textStr, reloadPlayer) {
        console.log('Found ads, switch to backup');
        streamInfo.UseBackupStream = true;
        streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
        if (reloadPlayer) {
            postMessage({ key: 'UboReloadPlayer' });
        }
        postMessage({ key: 'UboShowAdBanner', isMidroll: streamInfo.IsMidroll });
    }

    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = STATE.StreamInfosByUrl[url];
        if (!streamInfo) {
            console.log('Unknown stream url', url);
            return textStr;
        }

        if (!OPTS.STRIP_AD_SEGMENTS) return textStr;

        if (streamInfo.UseBackupStream) {
            if (!streamInfo.Encodings) {
                console.log('Found backup stream but not main stream?');
                streamInfo.UseBackupStream = false;
                postMessage({ key: 'UboReloadPlayer' });
                return '';
            } else {
                const streamM3u8Url = streamInfo.Encodings.match(/^https:.*\.m3u8$/m)[0];
                const streamM3u8Response = await realFetch(streamM3u8Url);
                if (streamM3u8Response.status === 200) {
                    const streamM3u8 = await streamM3u8Response.text();
                    if (streamM3u8 && !streamM3u8.includes(OPTS.AD_SIGNIFIER)) {
                        console.log('No more ads on main stream. Triggering player reload to go back to main stream...');
                        streamInfo.UseBackupStream = false;
                        postMessage({ key: 'UboHideAdBanner' });
                        postMessage({ key: 'UboReloadPlayer' });
                    } else if (!streamM3u8.includes('"MIDROLL"') && !streamM3u8.includes('"midroll"')) {
                        const lines = streamM3u8.replace('\r', '').split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                                if (!line.includes(OPTS.LIVE_SIGNIFIER) && !streamInfo.RequestedAds.has(lines[i + 1])) {
                                    streamInfo.RequestedAds.add(lines[i + 1]);
                                    fetch(lines[i + 1]).then(response => response.blob());
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            if (!streamInfo.BackupEncodings) return '';
        } else if (textStr.includes(OPTS.AD_SIGNIFIER)) {
            onFoundAd(streamInfo, textStr, true);
            return '';
        } else {
            postMessage({ key: 'UboHideAdBanner' });
        }
        return textStr;
    }

    function hookWorkerFetch() {
        console.log('hookWorkerFetch');
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string' && url.endsWith('m3u8')) {
                return new Promise((resolve, reject) => {
                    realFetch(url, options).then(async response => {
                        const str = await processM3U8(url, await response.text(), realFetch);
                        resolve(new Response(str));
                    }).catch(err => {
                        console.log('fetch hook err', err);
                        reject(err);
                    });
                });
            } else if (url.includes('/api/channel/hls/') && !url.includes('picture-by-picture')) {
                const channelName = new URL(url).pathname.match(/([^\/]+)(?=\.\w+$)/)[0];
                if (STATE.CurrentChannelNameFromM3U8 !== channelName) {
                    postMessage({
                        key: 'UboChannelNameM3U8Changed',
                        value: channelName
                    });
                }
                STATE.CurrentChannelNameFromM3U8 = channelName;

                if (OPTS.STRIP_AD_SEGMENTS) {
                    return new Promise(async (resolve, reject) => {
                        let streamInfo = STATE.StreamInfos[channelName];
                        if (!streamInfo) {
                            STATE.StreamInfos[channelName] = streamInfo = {
                                RequestedAds: new Set(),
                                Encodings: null,
                                BackupEncodings: null,
                                IsMidroll: false,
                                UseBackupStream: false,
                                ChannelName: channelName
                            };
                            for (let i = 0; i < 2; i++) {
                                let encodingsUrl = url;
                                if (i === 1) {
                                    const accessTokenResponse = await getAccessToken(channelName, OPTS.BACKUP_PLAYER_TYPE, OPTS.BACKUP_PLATFORM, realFetch);
                                    if (accessTokenResponse && accessTokenResponse.status === 200) {
                                        const accessToken = await accessTokenResponse.json();
                                        const urlInfo = new URL(`https://usher.ttvnw.net/api/channel/hls/${channelName}.m3u8${new URL(url).search}`);
                                        urlInfo.searchParams.set('sig', accessToken.data.streamPlaybackAccessToken.signature);
                                        urlInfo.searchParams.set('token', accessToken.data.streamPlaybackAccessToken.value);
                                        encodingsUrl = urlInfo.href;
                                    } else {
                                        resolve(accessTokenResponse);
                                        return;
                                    }
                                }
                                const encodingsM3u8Response = await realFetch(encodingsUrl, options);
                                if (encodingsM3u8Response && encodingsM3u8Response.status === 200) {
                                    const encodingsM3u8 = await encodingsM3u8Response.text();
                                    if (i === 0) {
                                        streamInfo.Encodings = encodingsM3u8;
                                        const streamM3u8Url = encodingsM3u8.match(/^https:.*\.m3u8$/m)[0];
                                        const streamM3u8Response = await realFetch(streamM3u8Url);
                                        if (streamM3u8Response.status === 200) {
                                            const streamM3u8 = await streamM3u8Response.text();
                                            if (streamM3u8.includes(OPTS.AD_SIGNIFIER)) {
                                                onFoundAd(streamInfo, streamM3u8, false);
                                            }
                                        } else {
                                            resolve(streamM3u8Response);
                                            return;
                                        }
                                    } else {
                                        const lowResLines = encodingsM3u8.replace('\r', '').split('\n');
                                        let lowResBestUrl = null;
                                        for (let j = 0; j < lowResLines.length; j++) {
                                            if (lowResLines[j].startsWith('#EXT-X-STREAM-INF')) {
                                                const res = parseAttributes(lowResLines[j]).RESOLUTION;
                                                if (res && lowResLines[j + 1].endsWith('.m3u8')) {
                                                    lowResBestUrl = lowResLines[j + 1];
                                                    break;
                                                }
                                            }
                                        }
                                        if (lowResBestUrl && streamInfo.Encodings) {
                                            const normalEncodingsM3u8 = streamInfo.Encodings;
                                            const normalLines = normalEncodingsM3u8.replace('\r', '').split('\n');
                                            for (let j = 0; j < normalLines.length - 1; j++) {
                                                if (normalLines[j].startsWith('#EXT-X-STREAM-INF')) {
                                                    const res = parseAttributes(normalLines[j]).RESOLUTION;
                                                    if (res) {
                                                        lowResBestUrl += ' ';
                                                        normalLines[j + 1] = lowResBestUrl;
                                                    }
                                                }
                                            }
                                            encodingsM3u8 = normalLines.join('\r\n');
                                        }
                                        streamInfo.BackupEncodings = encodingsM3u8;
                                    }
                                    const lines = encodingsM3u8.replace('\r', '').split('\n');
                                    for (let j = 0; j < lines.length; j++) {
                                        if (!lines[j].startsWith('#') && lines[j].includes('.m3u8')) {
                                            STATE.StreamInfosByUrl[lines[j].trimEnd()] = streamInfo;
                                        }
                                    }
                                } else {
                                    resolve(encodingsM3u8Response);
                                    return;
                                }
                            }
                        }
                        resolve(new Response(streamInfo.UseBackupStream ? streamInfo.BackupEncodings : streamInfo.Encodings));
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }

    function makeGraphQlPacket(event, radToken, payload) {
        return [{
            operationName: 'ClientSideAdEventHandling_RecordAdEvent',
            variables: {
                input: {
                    eventName: event,
                    eventPayload: JSON.stringify(payload),
                    radToken
                }
            },
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b'
                }
            }
        }];
    }

    function getAccessToken(channelName, playerType, platform, realFetch) {
        if (!platform) platform = 'web';
        const body = {
            operationName: 'PlaybackAccessToken_Template',
            query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
                streamPlaybackAccessToken(channelName: $login, params: {platform: "${platform}", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
                    value
                    signature
                    __typename
                }
                videoPlaybackAccessToken(id: $vodID, params: {platform: "${platform}", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
                    value
                    signature
                    __typename
                }
            }`,
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: '',
                playerType
            }
        };
        return gqlRequest(body, realFetch);
    }

    function gqlRequest(body, realFetch) {
        const headers = {
            'Client-Id': OPTS.CLIENT_ID,
            'Client-Integrity': STATE.ClientIntegrityHeader,
            'X-Device-Id': OPTS.ROLLING_DEVICE_ID ? STATE.gql_device_id_rolling : STATE.gql_device_id,
            'Authorization': STATE.AuthorizationHeader
        };
        return realFetch('https://gql.twitch.tv/gql', {
            method: 'POST',
            body: JSON.stringify(body),
            headers
        });
    }

    function parseAttributes(str) {
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
               .filter(Boolean)
               .map(x => {
                   const [key, value] = x.split('=');
                   const num = Number(value);
                   return [key, Number.isNaN(num) ? value.replace(/^"|"$/g, '') : num];
               })
        );
    }

    async function tryNotifyAdsWatchedM3U8(streamM3u8) {
        if (!streamM3u8 || !streamM3u8.includes(OPTS.AD_SIGNIFIER)) return 1;
        const matches = streamM3u8.match(/#EXT-X-DATERANGE:(ID="stitched-ad-[^\n]+)\n/);
        if (matches.length > 1) {
            const attr = parseAttributes(matches[1]);
            const podLength = parseInt(attr['X-TV-TWITCH-AD-POD-LENGTH'] || '1');
            const radToken = attr['X-TV-TWITCH-AD-RADS-TOKEN'];
            const baseData = {
                stitched: true,
                roll_type: attr['X-TV-TWITCH-AD-ROLL-TYPE'].toLowerCase(),
                player_mute: false,
                player_volume: 0.5,
                visible: true
            };
            for (let podPosition = 0; podPosition < podLength; podPosition++) {
                if (OPTS.NOTIFY_ADS_WATCHED_MIN_REQUESTS) {
                    await gqlRequest(makeGraphQlPacket('video_ad_pod_complete', radToken, baseData));
                } else {
                    const extendedData = {
                        ...baseData,
                        ad_id: attr['X-TV-TWITCH-AD-ADVERTISER-ID'],
                        ad_position: podPosition,
                        duration: 30,
                        creative_id: attr['X-TV-TWITCH-AD-CREATIVE-ID'],
                        total_ads: podLength,
                        order_id: attr['X-TV-TWITCH-AD-ORDER-ID'],
                        line_item_id: attr['X-TV-TWITCH-AD-LINE-ITEM-ID']
                    };
                    await gqlRequest(makeGraphQlPacket('video_ad_impression', radToken, extendedData));
                    for (let quartile = 0; quartile < 4; quartile++) {
                        await gqlRequest(makeGraphQlPacket('video_ad_quartile_complete', radToken, { ...extendedData, quartile: quartile + 1 }));
                    }
                    await gqlRequest(makeGraphQlPacket('video_ad_pod_complete', radToken, baseData));
                }
            }
        }
        return 0;
    }

    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach(worker => worker.postMessage({ key, value }));
    }

    function hookFetch() {
        const realFetch = window.fetch;
        window.fetch = function(url, init, ...args) {
            if (typeof url === 'string' && url.includes('gql')) {
                const deviceId = init.headers['X-Device-Id'] || init.headers['Device-ID'];
                if (deviceId) {
                    STATE.gql_device_id = deviceId;
                    postTwitchWorkerMessage('UboUpdateDeviceId', STATE.gql_device_id);
                }
                if (init.body.includes('PlaybackAccessToken')) {
                    const newBody = JSON.parse(init.body);
                    if (Array.isArray(newBody)) {
                        newBody.forEach(b => b.variables.playerType = OPTS.ACCESS_TOKEN_PLAYER_TYPE);
                    } else {
                        newBody.variables.playerType = OPTS.ACCESS_TOKEN_PLAYER_TYPE;
                    }
                    init.body = JSON.stringify(newBody);

                    if (OPTS.ROLLING_DEVICE_ID) {
                        if (init.headers['X-Device-Id']) init.headers['X-Device-Id'] = STATE.gql_device_id_rolling;
                        if (init.headers['Device-ID']) init.headers['Device-ID'] = STATE.gql_device_id_rolling;
                    }

                    if (init.headers['Client-Integrity']) {
                        STATE.ClientIntegrityHeader = init.headers['Client-Integrity'];
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', STATE.ClientIntegrityHeader);
                    }

                    if (init.headers['Authorization']) {
                        STATE.AuthorizationHeader = init.headers['Authorization'];
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', STATE.AuthorizationHeader);
                    }
                }
            }
            return realFetch.apply(this, arguments);
        };
    }

    function reloadTwitchPlayer(isSeek, isPausePlay) {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) return root.stateNode;
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) return result;
                node = node.sibling;
            }
            return null;
        }

        function findReactRootNode() {
            const rootNode = document.querySelector('#root');
            return rootNode?._reactRootContainer?._internalRoot?.current || Object.values(rootNode).find(x => x.startsWith('__reactContainer'))?.[rootNode];
        }

        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            console.log('Could not find react root');
            return;
        }

        const player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props?.mediaPlayerInstance)?.props.mediaPlayerInstance;
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        if (!player || !playerState) {
            console.log('Could not find player or player state');
            return;
        }

        if (player.paused || player.core?.paused) return;

        if (isSeek) {
            console.log('Force seek to reset player (hopefully fixing any audio desync)', `pos:${player.getPosition()}`, `range:${JSON.stringify(player.getBuffered())}`);
            const pos = player.getPosition();
            player.seekTo(0);
            player.seekTo(pos);
            return;
        }

        if (isPausePlay) {
            player.pause();
            player.play();
            return;
        }

        const lsKeyQuality = 'video-quality';
        const lsKeyMuted = 'video-muted';
        const lsKeyVolume = 'volume';
        const currentQualityLS = localStorage.getItem(lsKeyQuality);
        const currentMutedLS = localStorage.getItem(lsKeyMuted);
        const currentVolumeLS = localStorage.getItem(lsKeyVolume);
        if (player?.core?.state) {
            localStorage.setItem(lsKeyMuted, JSON.stringify({ default: player.core.state.muted }));
            localStorage.setItem(lsKeyVolume, player.core.state.volume);
        }
        if (player?.core?.state?.quality?.group) {
            localStorage.setItem(lsKeyQuality, JSON.stringify({ default: player.core.state.quality.group }));
        }
        playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
        setTimeout(() => {
            localStorage.setItem(lsKeyQuality, currentQualityLS);
            localStorage.setItem(lsKeyMuted, currentMutedLS);
            localStorage.setItem(lsKeyVolume, currentVolumeLS);
        }, 3000);
    }

    window.reloadTwitchPlayer = reloadTwitchPlayer;

    hookFetch();

    function onContentLoaded() {
        try {
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
        } catch {}
        try {
            Object.defineProperty(document, 'hidden', { get: () => false });
        } catch {}

        const block = e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        document.addEventListener('visibilitychange', block, true);
        document.addEventListener('webkitvisibilitychange', block, true);
        document.addEventListener('mozvisibilitychange', block, true);
        document.addEventListener('hasFocus', block, true);

        try {
            if (/Firefox/.test(navigator.userAgent)) {
                Object.defineProperty(document, 'mozHidden', { get: () => false });
            } else {
                Object.defineProperty(document, 'webkitHidden', { get: () => false });
            }
        } catch {}

        const keysToCache = ['video-quality', 'video-muted', 'volume', 'lowLatencyModeEnabled', 'persistenceEnabled'];
        const cachedValues = new Map(keysToCache.map(key => [key, localStorage.getItem(key)]));

        const realSetItem = localStorage.setItem;
        localStorage.setItem = function(key, value) {
            if (cachedValues.has(key)) {
                cachedValues.set(key, value);
            }
            realSetItem.apply(this, arguments);
        };

        const realGetItem = localStorage.getItem;
        localStorage.getItem = function(key) {
            return cachedValues.has(key) ? cachedValues.get(key) : realGetItem.apply(this, arguments);
        };
    }

    if (['complete', 'loaded', 'interactive'].includes(document.readyState)) {
        onContentLoaded();
    } else {
        window.addEventListener('DOMContentLoaded', onContentLoaded);
    }
})();
