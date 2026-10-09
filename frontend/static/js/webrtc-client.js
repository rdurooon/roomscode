const RTC_CONFIG = {
    // Só STUN público: suficiente para redes comuns. Redes de instituição/NAT restritivo
    // exigiriam um TURN alcançável pela internet, que esta hospedagem (CGNAT + Cloudflare Tunnel) não tem.
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// Tentativas de ICE restart do Host antes de desistir (a recuperação seguinte é o espectador pedir uma conexão nova).
const MAX_ICE_RESTART_ATTEMPTS = 3;

// Espectador: esperas e tentativas antes de mostrar "Não foi possível receber a tela do host."
const OFFER_WAIT_MS = 4000; // sem oferta do Host nesse tempo, pede de novo
const MAX_OFFER_ATTEMPTS = 3; // pedidos de oferta sem resposta antes de desistir
const MEDIA_TIMEOUT_MS = 12000; // com oferta recebida, tempo até o primeiro quadro aparecer
const DISCONNECTED_GRACE_MS = 8000; // 'disconnected' costuma ser passageiro; só desiste depois disso
const MAX_AUTO_RETRIES = 2; // tentativas automáticas completas antes de pedir um clique do usuário
const FRAME_POLL_MS = 500;

function randomSessionId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fila que aplica os sinais remotos em ordem e segura os candidatos ICE que chegam antes da
 * descrição remota (addIceCandidate sem ela falha e o candidato se perde pra sempre).
 */
function createSignalQueue(pc) {
    let chain = Promise.resolve();
    let remoteDescriptionSet = false;
    const pendingCandidates = [];

    function enqueue(task, label) {
        chain = chain.then(task).catch((err) => console.warn(`RoomsCode: falha ao aplicar ${label}.`, err));
        return chain;
    }

    async function applyCandidate(candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            // Candidato de uma geração ICE antiga ou duplicado: não derruba a conexão.
            console.warn('RoomsCode: candidato ICE ignorado.', err);
        }
    }

    return {
        setRemoteDescription(description, afterApplied) {
            return enqueue(async () => {
                await pc.setRemoteDescription(new RTCSessionDescription(description));
                remoteDescriptionSet = true;
                while (pendingCandidates.length) {
                    await applyCandidate(pendingCandidates.shift());
                }
                if (afterApplied) await afterApplied();
            }, `descrição remota (${description.type})`);
        },
        addCandidate(candidate) {
            return enqueue(async () => {
                if (!remoteDescriptionSet) {
                    pendingCandidates.push(candidate);
                    return;
                }
                await applyCandidate(candidate);
            }, 'candidato ICE');
        },
    };
}

/**
 * Tenta recuperar uma RTCPeerConnection que degradou ('disconnected' ou 'failed') via ICE
 * restart. Só quem criou a oferta (o Host) pode reiniciar o ICE.
 */
function attemptIceRestart(pc, onOffer, attemptsRef, label) {
    if (attemptsRef.count >= MAX_ICE_RESTART_ATTEMPTS) {
        console.warn(`RoomsCode: ICE restart esgotado para ${label}.`);
        return;
    }
    attemptsRef.count += 1;
    console.warn(`RoomsCode: conexão de vídeo com ${label} degradou (tentativa ${attemptsRef.count}/${MAX_ICE_RESTART_ATTEMPTS}) — tentando ICE restart.`);

    try {
        if (typeof pc.restartIce === 'function') {
            // Só marca a necessidade; o onnegotiationneeded da conexão cria a nova oferta.
            pc.restartIce();
            return;
        }
        pc.createOffer({ iceRestart: true })
            .then((offer) => pc.setLocalDescription(offer).then(() => offer))
            .then((offer) => onOffer(offer))
            .catch((err) => console.error(`RoomsCode: falha no ICE restart (fallback) com ${label}.`, err));
    } catch (err) {
        console.error(`RoomsCode: falha ao tentar ICE restart com ${label}.`, err);
    }
}

function setScreenPlaceholderVisible(visible) {
    const placeholder = document.getElementById('screen-placeholder');
    if (placeholder) {
        placeholder.style.display = visible ? 'flex' : 'none';
    }
}

// ---- Lado do Host ----
//
// Estado fora da função: initWebRTCHost roda de novo quando o Host reconecta e precisa desmontar
// tudo que a chamada anterior deixou de pé (conexões zumbis, listeners duplicados no socket).
let hostPeers = {}; // spectatorSid -> { pc, session, queue }
let hostLocalStream = null;
let hostSignalHandler = null;
let hostOfferRequestHandler = null;

function closeHostPeer(spectatorSid) {
    const peer = hostPeers[spectatorSid];
    if (!peer) return;
    delete hostPeers[spectatorSid];
    try {
        peer.pc.close();
    } catch (err) {
        // Fechar uma conexão já degradada raramente lança; não interrompe o resto da limpeza.
    }
}

function closeAllHostPeers() {
    Object.keys(hostPeers).forEach(closeHostPeer);
}

/**
 * Lado do Host: uma conexão WebRTC por Espectador (mesh), criada SOB PEDIDO do espectador
 * (`video_offer_requested`), nunca por palpite do Host. Idempotente — pode ser chamada de
 * novo a cada reconexão do Host.
 */
function initWebRTCHost(socket, roomState) {
    closeAllHostPeers();
    if (hostLocalStream) {
        hostLocalStream.getTracks().forEach((track) => track.stop());
        hostLocalStream = null;
    }
    if (hostSignalHandler) {
        socket.off('webrtc_signal', hostSignalHandler);
        hostSignalHandler = null;
    }
    if (hostOfferRequestHandler) {
        socket.off('video_offer_requested', hostOfferRequestHandler);
        hostOfferRequestHandler = null;
    }

    let toggleBtn = document.getElementById('share-toggle-btn');
    const videoEl = document.getElementById('video-display');
    let startingShare = false;

    // O botão é clonado pra descartar listeners de chamadas anteriores desta função.
    if (toggleBtn) {
        const freshToggleBtn = toggleBtn.cloneNode(true);
        toggleBtn.replaceWith(freshToggleBtn);
        toggleBtn = freshToggleBtn;
    }

    hostSignalHandler = (data) => {
        const { sender_sid: senderSid, signal, session } = data || {};
        const peer = hostPeers[senderSid];
        // Sinal de uma tentativa que o espectador já abandonou: descarta.
        if (!peer || peer.session !== session || !signal) return;

        if (signal.type === 'answer') {
            peer.queue.setRemoteDescription(signal);
        } else if (signal.candidate) {
            peer.queue.addCandidate(signal.candidate);
        }
    };
    socket.on('webrtc_signal', hostSignalHandler);

    function startPeer(spectatorSid, session) {
        // Pedido novo do mesmo espectador substitui a conexão anterior (retentativa ou F5).
        closeHostPeer(spectatorSid);

        const pc = new RTCPeerConnection(RTC_CONFIG);
        const peer = { pc, session, queue: createSignalQueue(pc) };
        hostPeers[spectatorSid] = peer;
        const isCurrent = () => hostPeers[spectatorSid] === peer;
        const iceRestartAttempts = { count: 0 };
        const sendSignal = (signal) => socket.emit('webrtc_signal', { target_sid: spectatorSid, signal, session });

        hostLocalStream.getTracks().forEach((track) => pc.addTrack(track, hostLocalStream));

        pc.onicecandidate = (event) => {
            if (event.candidate && isCurrent()) sendSignal({ candidate: event.candidate });
        };

        pc.oniceconnectionstatechange = () => {
            if (!isCurrent()) return;
            const state = pc.iceConnectionState;
            if (state === 'connected' || state === 'completed') {
                iceRestartAttempts.count = 0;
                return;
            }
            if (state === 'disconnected' || state === 'failed') {
                attemptIceRestart(pc, sendSignal, iceRestartAttempts, `espectador ${spectatorSid}`);
            }
        };

        // Dispara ao adicionar a track (acima) e quando pc.restartIce() é chamado.
        pc.onnegotiationneeded = async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                if (isCurrent()) sendSignal(offer);
            } catch (err) {
                console.error('RoomsCode: falha ao (re)negociar conexão com espectador.', err);
            }
        };
    }

    hostOfferRequestHandler = (data) => {
        const { sid, session } = data || {};
        // Sem tela sendo compartilhada não há o que oferecer: o espectador aguarda o aviso de início.
        if (!sid || !session || !hostLocalStream) return;
        startPeer(sid, session);
    };
    socket.on('video_offer_requested', hostOfferRequestHandler);

    async function startShare() {
        // getDisplayMedia só existe em contexto seguro (https:// ou localhost).
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            if (window.showToast) {
                window.showToast(window.t('room.share_unavailable_insecure_context'), 'error');
            }
            return;
        }
        if (startingShare || hostLocalStream) return;
        startingShare = true;

        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        } catch (err) {
            console.error('RoomsCode: compartilhamento cancelado ou negado pelo navegador.', err);
            if (window.showToast) {
                window.showToast(window.t('room.share_permission_denied'), 'error');
            }
            return;
        } finally {
            startingShare = false;
        }

        hostLocalStream = stream;
        videoEl.srcObject = hostLocalStream;
        setScreenPlaceholderVisible(false);
        toggleBtn.textContent = window.t('room.share_toggle_stop');
        toggleBtn.classList.remove('share-btn-center');
        toggleBtn.classList.add('share-btn-corner');

        // Se o usuário parar pelo painel do navegador em vez do nosso botão, refletimos no botão também.
        hostLocalStream.getVideoTracks()[0].addEventListener('ended', stopShare);

        // Os espectadores presentes respondem a este aviso pedindo a oferta.
        socket.emit('screen_share_started');
    }

    function stopShare() {
        if (hostLocalStream) {
            // Fecha as conexões em vez de renegociar: uma nova transmissão começa limpa, com conexões novas.
            closeAllHostPeers();
            hostLocalStream.getTracks().forEach((track) => track.stop());
            hostLocalStream = null;
        }

        videoEl.srcObject = null;
        setScreenPlaceholderVisible(true);
        toggleBtn.textContent = window.t('room.share_toggle_start');
        toggleBtn.classList.remove('share-btn-corner');
        toggleBtn.classList.add('share-btn-center');

        socket.emit('screen_share_stopped');
    }

    toggleBtn.addEventListener('click', () => {
        if (hostLocalStream) {
            stopShare();
        } else {
            startShare();
        }
    });

    // Espectador que saiu de verdade: libera a conexão dele (chamado por room-init.js via 'spectator_left').
    window.onSpectatorLeft = (spectatorSid) => {
        closeHostPeer(spectatorSid);
    };
}

// ---- Lado do Espectador ----
let spectatorSession = null; // { destroy() } da inicialização atual

/**
 * Lado do Espectador: recebe o vídeo do Host com estados explícitos e individuais:
 *   waiting    — o Host não está compartilhando
 *   connecting — pedindo/negociando a conexão ("Conectando…")
 *   playing    — o primeiro quadro apareceu
 *   failed     — não chegou: "Não foi possível receber a tela do host." + "Tentar novamente"
 * Idempotente — descarta a inicialização anterior a cada 'joined_room' (entrada, F5 ou reconexão).
 */
function initWebRTCSpectator(socket, roomState) {
    if (spectatorSession) spectatorSession.destroy();

    const videoEl = document.getElementById('video-display');
    const placeholder = document.getElementById('screen-placeholder');
    let destroyed = false;
    let state = null;

    let pc = null;
    let queue = null;
    let session = null;
    let hostSid = null;
    let offerTimer = null;
    let mediaTimer = null;
    let disconnectedTimer = null;
    let frameTimer = null;
    let offerAttempts = 0;
    let autoRetries = 0;
    let hasWarnedUnstable = false;

    // Muted: sem isso o navegador pode bloquear o autoplay depois de um F5 (a página recarrega sem clique) e a tela fica preta.
    videoEl.muted = true;

    function renderStatus(message, withRetry) {
        if (!placeholder) return;
        placeholder.style.display = 'flex';
        placeholder.textContent = message;
        if (withRetry) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'screen-retry-btn';
            button.textContent = window.t('room.video_retry');
            button.addEventListener('click', manualRetry);
            placeholder.appendChild(button);
        }
    }

    function setState(next) {
        state = next;
        if (next === 'playing') {
            setScreenPlaceholderVisible(false);
            if (window.setScreenActive) window.setScreenActive(true);
            return;
        }
        videoEl.srcObject = null;
        if (window.setScreenActive) window.setScreenActive(false);
        if (next === 'waiting') {
            renderStatus(window.t('room.waiting_screen_share'), false);
            // Tela cheia sem vídeo só mostraria uma área preta.
            if (window.exitScreenFullscreen) window.exitScreenFullscreen();
        } else if (next === 'connecting') {
            renderStatus(window.t('room.video_connecting'), false);
        } else if (next === 'failed') {
            renderStatus(window.t('room.video_failed'), true);
        }
    }

    function clearTimers() {
        clearTimeout(offerTimer);
        clearTimeout(mediaTimer);
        clearTimeout(disconnectedTimer);
        clearInterval(frameTimer);
        offerTimer = mediaTimer = disconnectedTimer = frameTimer = null;
    }

    function teardownAttempt() {
        clearTimers();
        if (pc) {
            const old = pc;
            pc = null;
            old.ontrack = old.onicecandidate = old.oniceconnectionstatechange = null;
            try {
                old.close();
            } catch (err) {
                // fechar uma conexão já degradada não deve travar a limpeza
            }
        }
        queue = null;
        session = null;
        hostSid = null;
    }

    function fail() {
        teardownAttempt();
        setState('failed');
    }

    // Uma tentativa deu errado (sem quadros, ICE failed...): refaz do zero algumas vezes antes de incomodar o usuário.
    function handleAttemptFailure(reason) {
        if (destroyed) return;
        console.warn(`RoomsCode: tentativa de receber a tela falhou (${reason}).`);
        if (autoRetries < MAX_AUTO_RETRIES) {
            autoRetries += 1;
            offerAttempts = 0;
            startAttempt();
        } else {
            fail();
        }
    }

    function checkFrame() {
        if (destroyed || state === 'playing' || !pc || !videoEl.srcObject) return;
        if (videoEl.videoWidth > 0) {
            clearTimeout(mediaTimer);
            clearInterval(frameTimer);
            mediaTimer = frameTimer = null;
            autoRetries = 0;
            hasWarnedUnstable = false;
            setState('playing');
        }
    }

    function onOfferTimeout() {
        offerTimer = null;
        if (destroyed) return;
        if (offerAttempts >= MAX_OFFER_ATTEMPTS) {
            fail();
        } else {
            startAttempt();
        }
    }

    function startAttempt() {
        if (destroyed) return;
        teardownAttempt();
        offerAttempts += 1;
        session = randomSessionId();
        const attemptSession = session;
        const attemptPc = new RTCPeerConnection(RTC_CONFIG);
        pc = attemptPc;
        queue = createSignalQueue(attemptPc);
        const isCurrent = () => !destroyed && pc === attemptPc;

        // Fica em "Conectando…" já na primeira tentativa; um quadro de tentativa anterior não deve sobrar na tela.
        if (state !== 'connecting') setState('connecting');
        else videoEl.srcObject = null;

        attemptPc.ontrack = (event) => {
            if (!isCurrent()) return;
            videoEl.srcObject = event.streams[0] || new MediaStream([event.track]);
            const playback = videoEl.play();
            if (playback && playback.catch) {
                playback.catch((err) => {
                    // Autoplay recusado pelo navegador: o botão "Tentar novamente" dá o clique que libera.
                    if (isCurrent() && err && err.name === 'NotAllowedError') fail();
                });
            }
            checkFrame();
        };

        attemptPc.onicecandidate = (event) => {
            if (event.candidate && hostSid && isCurrent()) {
                socket.emit('webrtc_signal', { target_sid: hostSid, signal: { candidate: event.candidate }, session: attemptSession });
            }
        };

        attemptPc.oniceconnectionstatechange = () => {
            if (!isCurrent()) return;
            const iceState = attemptPc.iceConnectionState;
            if (iceState === 'connected' || iceState === 'completed') {
                clearTimeout(disconnectedTimer);
                disconnectedTimer = null;
                hasWarnedUnstable = false;
            } else if (iceState === 'failed') {
                handleAttemptFailure('ICE failed');
            } else if (iceState === 'disconnected') {
                if (!hasWarnedUnstable) {
                    hasWarnedUnstable = true;
                    if (window.showToast) window.showToast(window.t('socket.video_connection_unstable'), 'error');
                }
                if (!disconnectedTimer) {
                    disconnectedTimer = setTimeout(() => {
                        disconnectedTimer = null;
                        if (isCurrent()) handleAttemptFailure('ICE disconnected');
                    }, DISCONNECTED_GRACE_MS);
                }
            }
        };

        // O espectador só pede; a oferta chega depois. Se ela nunca chegar, pede de novo.
        socket.emit('video_request_offer', { session: attemptSession });
        offerTimer = setTimeout(onOfferTimeout, OFFER_WAIT_MS);
    }

    function manualRetry() {
        autoRetries = 0;
        offerAttempts = 0;
        startAttempt();
    }

    function onSignal(data) {
        const { sender_sid: senderSid, signal, session: signalSession } = data || {};
        // Sinal de uma tentativa antiga (já abandonada): descarta.
        if (destroyed || !pc || !signal || signalSession !== session) return;
        const attemptSession = session;
        const attemptPc = pc;
        const attemptQueue = queue;
        hostSid = senderSid;
        roomState.hostSid = senderSid;

        if (signal.type === 'offer') {
            clearTimeout(offerTimer);
            offerTimer = null;
            if (!mediaTimer && state !== 'playing') {
                mediaTimer = setTimeout(() => {
                    mediaTimer = null;
                    handleAttemptFailure('sem quadros');
                }, MEDIA_TIMEOUT_MS);
                frameTimer = setInterval(checkFrame, FRAME_POLL_MS);
            }
            attemptQueue.setRemoteDescription(signal, async () => {
                const answer = await attemptPc.createAnswer();
                await attemptPc.setLocalDescription(answer);
                if (!destroyed && pc === attemptPc) {
                    socket.emit('webrtc_signal', { target_sid: senderSid, signal: answer, session: attemptSession });
                }
            });
        } else if (signal.candidate) {
            attemptQueue.addCandidate(signal.candidate);
        }
    }

    function onScreenShareStarted() {
        if (destroyed) return;
        autoRetries = 0;
        offerAttempts = 0;
        startAttempt();
    }

    function onScreenShareStopped() {
        if (destroyed) return;
        teardownAttempt();
        setState('waiting');
    }

    socket.on('webrtc_signal', onSignal);
    socket.on('screen_share_started', onScreenShareStarted);
    socket.on('screen_share_stopped', onScreenShareStopped);

    spectatorSession = {
        destroy() {
            destroyed = true;
            teardownAttempt();
            socket.off('webrtc_signal', onSignal);
            socket.off('screen_share_started', onScreenShareStarted);
            socket.off('screen_share_stopped', onScreenShareStopped);
            if (spectatorSession && spectatorSession.destroy === this.destroy) spectatorSession = null;
        },
    };

    // Estado inicial vem do servidor: quem entra (ou volta de um F5) com a tela já em andamento a pede na hora.
    if (roomState.screenSharing) {
        startAttempt();
    } else {
        setState('waiting');
    }
}

window.initWebRTCHost = initWebRTCHost;
window.initWebRTCSpectator = initWebRTCSpectator;
