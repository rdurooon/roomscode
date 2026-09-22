const RTC_CONFIG = {
    // Só STUN público por enquanto (suficiente para o MVP, e é o que o
    // usuário decidiu manter por ora). Pra adicionar um servidor TURN no
    // futuro (necessário pra redes de instituição/NAT restritivo — ver
    // aprendizado registrado sobre mesh WebRTC falhando nesse cenário),
    // basta acrescentar outra entrada em `iceServers`, por exemplo:
    //   { urls: 'turn:seu-turn-server:3478', username: '...', credential: '...' }
    // Agora que o site está atrás de um domínio HTTPS de verdade, também dá
    // pra usar `turns:` (TURN sobre TLS, porta 443) sem restrição de
    // "mixed content" — útil em redes que bloqueiam qualquer UDP/porta não
    // convencional.
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// Depois de quantas mudanças pro estado 'failed' seguidas (sem voltar a
// 'connected' entre elas) desistimos de tentar ICE restart sozinhos e só
// avisamos o usuário — evita um loop infinito de restarts numa rede que
// simplesmente não tem mais caminho nenhum entre Host e Espectador (aí quem
// resolve é reconectar de verdade, o que o room-init.js já cobre).
const MAX_ICE_RESTART_ATTEMPTS = 3;

/**
 * Tenta recuperar uma RTCPeerConnection que degradou ('disconnected' ou
 * 'failed') via ICE restart, sem esperar o usuário fazer nada. Só quem
 * criou a oferta original (o Host, nas duas topologias que essa página
 * implementa) pode de fato reiniciar o ICE — o lado que só responde
 * (Espectador) apenas observa e avisa (ver oniceconnectionstatechange do
 * Espectador logo abaixo).
 */
function attemptIceRestart(pc, onOffer, attemptsRef, label) {
    if (attemptsRef.count >= MAX_ICE_RESTART_ATTEMPTS) {
        console.warn(`RoomsCode: ICE restart esgotado para ${label} — aguardando reconexão completa.`);
        return;
    }
    attemptsRef.count += 1;
    console.warn(`RoomsCode: conexão de vídeo com ${label} degradou (tentativa ${attemptsRef.count}/${MAX_ICE_RESTART_ATTEMPTS}) — tentando ICE restart.`);

    try {
        if (typeof pc.restartIce === 'function') {
            // API moderna: só marca a necessidade de restart; o próprio
            // onnegotiationneeded (já registrado na criação da conexão)
            // dispara a nova oferta com credenciais ICE renovadas.
            pc.restartIce();
            return;
        }
        // Fallback pra navegadores sem RTCPeerConnection.restartIce():
        // cria a oferta de restart manualmente.
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
// Estado guardado fora da função (em vez de local a ela) de propósito:
// initWebRTCHost precisa poder ser chamada de novo depois que o Host
// reconecta (queda + F5, ver room-init.js/host_reconnect_success), e nesse
// caso precisa primeiro desmontar tudo que a chamada anterior deixou de pé
// — sem isso, sobrariam RTCPeerConnections zumbis e listeners duplicados no
// socket, cada evento sendo processado duas vezes.
let hostPeerConnections = {}; // spectatorSid -> RTCPeerConnection
let hostLocalStream = null;
let hostWebrtcSignalHandler = null;

/**
 * Fecha e descarta a conexão de um espectador específico. Usada tanto na
 * limpeza geral no início de initWebRTCHost quanto isoladamente quando só
 * precisamos derrubar a conexão de UM espectador que saiu de verdade (ver
 * window.onSpectatorLeft).
 */
function closeHostPeerConnection(spectatorSid) {
    const pc = hostPeerConnections[spectatorSid];
    if (!pc) return;
    try {
        pc.close();
    } catch (err) {
        // Fechar uma conexão já degradada raramente lança, mas não é
        // motivo pra interromper a limpeza do resto.
    }
    delete hostPeerConnections[spectatorSid];
}

/**
 * Lado do Host: cria uma conexão WebRTC por Espectador (topologia mesh).
 * Idempotente — pode ser chamada de novo a cada reconexão do Host, recriando as conexões existentes.
 */
function initWebRTCHost(socket, roomState) {
    // Limpeza de uma chamada anterior (reconexão do Host).
    Object.keys(hostPeerConnections).forEach(closeHostPeerConnection);
    hostPeerConnections = {};
    if (hostLocalStream) {
        hostLocalStream.getTracks().forEach((track) => track.stop());
        hostLocalStream = null;
    }
    if (hostWebrtcSignalHandler) {
        socket.off('webrtc_signal', hostWebrtcSignalHandler);
        hostWebrtcSignalHandler = null;
    }

    const peerConnections = hostPeerConnections;

    let toggleBtn = document.getElementById('share-toggle-btn');
    const videoEl = document.getElementById('video-display');

    // O botão é clonado (descartando o nó antigo) pra garantir que nenhum
    // listener de 'click' de uma chamada anterior desta função continue
    // vivo — sem isso, depois de um reconnect do Host, cada clique em
    // "compartilhar" chamaria startShare/stopShare uma vez a mais por
    // reconexão que já aconteceu na página.
    if (toggleBtn) {
        const freshToggleBtn = toggleBtn.cloneNode(true);
        toggleBtn.replaceWith(freshToggleBtn);
        toggleBtn = freshToggleBtn;
    }

    hostWebrtcSignalHandler = async (data) => {
        const { sender_sid: senderSid, signal } = data;
        const pc = peerConnections[senderSid];
        if (!pc) return;

        if (signal.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    };
    socket.on('webrtc_signal', hostWebrtcSignalHandler);

    async function startShare() {
        // getDisplayMedia só existe em contexto seguro (https:// ou
        // localhost). Se faltar, o clique parecia "não fazer nada" antes —
        // agora avisamos o motivo real.
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            if (window.showToast) {
                window.showToast(
                    window.t('room.share_unavailable_insecure_context'),
                    'error'
                );
            }
            return;
        }

        try {
            hostLocalStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        } catch (err) {
            console.error('RoomsCode: compartilhamento cancelado ou negado pelo navegador.', err);
            if (window.showToast) {
                window.showToast(window.t('room.share_permission_denied'), 'error');
            }
            return;
        }

        videoEl.srcObject = hostLocalStream;
        setScreenPlaceholderVisible(false);
        toggleBtn.textContent = window.t('room.share_toggle_stop');
        toggleBtn.classList.remove('share-btn-center');
        toggleBtn.classList.add('share-btn-corner');

        Object.values(peerConnections).forEach((pc) => {
            hostLocalStream.getTracks().forEach((track) => pc.addTrack(track, hostLocalStream));
        });

        // Se o usuário parar pelo próprio painel do navegador (em vez do
        // nosso botão), refletimos o estado do botão também.
        hostLocalStream.getVideoTracks()[0].addEventListener('ended', stopShare);
    }

    function stopShare() {
        if (hostLocalStream) {
            // pc.removeTrack() de fato tira a track da conexão e dispara
            // renegociação (só track.stop() não faz isso).
            Object.values(peerConnections).forEach((pc) => {
                pc.getSenders().forEach((sender) => {
                    if (sender.track && hostLocalStream.getTracks().includes(sender.track)) {
                        pc.removeTrack(sender);
                    }
                });
            });
            hostLocalStream.getTracks().forEach((track) => track.stop());
            hostLocalStream = null;
        }

        videoEl.srcObject = null;
        setScreenPlaceholderVisible(true);
        toggleBtn.textContent = window.t('room.share_toggle_start');
        toggleBtn.classList.remove('share-btn-corner');
        toggleBtn.classList.add('share-btn-center');

        // Sinal explícito via socket — mais confiável do que depender só
        // do estado da track WebRTC chegando no Espectador.
        if (roomState.code) {
            socket.emit('screen_share_stopped', { room_code: roomState.code });
        }
    }

    toggleBtn.addEventListener('click', () => {
        if (hostLocalStream) {
            stopShare();
        } else {
            startShare();
        }
    });

    // Chamado (via window.onSpectatorJoined) quando um novo Espectador entra
    // na sala, para abrir uma nova conexão de vídeo dedicada a ele — e
    // também reaproveitado por room-init.js logo após um reconnect do Host,
    // uma vez pra cada espectador que já estava na sala (ver comentário
    // grande no topo desta função).
    window.onSpectatorJoined = (spectatorSid) => {
        // Defensivo: se por algum motivo já existir uma conexão pra esse
        // sid (não deveria, sids são únicos por conexão), fecha a antiga
        // antes de recriar, pra nunca deixar duas RTCPeerConnections
        // competindo pelo mesmo espectador.
        closeHostPeerConnection(spectatorSid);

        const pc = new RTCPeerConnection(RTC_CONFIG);
        peerConnections[spectatorSid] = pc;
        const iceRestartAttempts = { count: 0 };

        if (hostLocalStream) {
            hostLocalStream.getTracks().forEach((track) => pc.addTrack(track, hostLocalStream));
        }

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_signal', {
                    target_sid: spectatorSid,
                    signal: { candidate: event.candidate },
                });
            }
        };

        // Monitora a saúde da conexão (rede instável, troca de rede, NAT) e tenta ICE restart automaticamente.
        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            if (state === 'connected' || state === 'completed') {
                iceRestartAttempts.count = 0; // conexão saudável de novo, reseta o contador
                return;
            }
            if (state === 'disconnected' || state === 'failed') {
                attemptIceRestart(
                    pc,
                    (offer) => socket.emit('webrtc_signal', { target_sid: spectatorSid, signal: offer }),
                    iceRestartAttempts,
                    `espectador ${spectatorSid}`
                );
            }
        };

        // onnegotiationneeded dispara tanto na criação da conexão (mesmo
        // sem nenhuma track ainda, se o host ainda não estava
        // compartilhando quando o espectador entrou) quanto sempre que uma
        // track é adicionada depois (ex: ao clicar em "Compartilhar tela")
        // ou quando pc.restartIce() é chamado acima, cobrindo os três
        // casos corretamente.
        pc.onnegotiationneeded = async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('webrtc_signal', { target_sid: spectatorSid, signal: offer });
            } catch (err) {
                console.error('RoomsCode: falha ao (re)negociar conexão com espectador.', err);
            }
        };
    };

    // Fecha e libera a conexão do espectador que saiu de verdade. Chamado por room-init.js via 'spectator_left'.
    window.onSpectatorLeft = (spectatorSid) => {
        closeHostPeerConnection(spectatorSid);
    };
}

// ---- Lado do Espectador ----
//
// Mesmo raciocínio do lado do Host: guardado fora da função pra
// initWebRTCSpectator poder ser chamada de novo (a cada 'joined_room' —
// tanto na entrada normal quanto numa reconexão, com F5 ou não — e também
// quando o Host reconecta) sem acumular RTCPeerConnections ou listeners
// duplicados no socket.
let spectatorPc = null;
let spectatorWebrtcSignalHandler = null;
let spectatorScreenShareStoppedHandler = null;

/**
 * Lado do Espectador: uma única conexão recebendo o vídeo do Host.
 * Idempotente — fecha a conexão anterior e recria do zero a cada 'joined_room' (F5 ou reconexão automática).
 */
function initWebRTCSpectator(socket, roomState) {
    if (spectatorPc) {
        try {
            spectatorPc.close();
        } catch (err) {
            // idem: fechar uma conexão já degradada não deveria travar a
            // reinicialização.
        }
        spectatorPc = null;
    }
    if (spectatorWebrtcSignalHandler) {
        socket.off('webrtc_signal', spectatorWebrtcSignalHandler);
        spectatorWebrtcSignalHandler = null;
    }
    if (spectatorScreenShareStoppedHandler) {
        socket.off('screen_share_stopped', spectatorScreenShareStoppedHandler);
        spectatorScreenShareStoppedHandler = null;
    }

    const videoEl = document.getElementById('video-display');
    let hasWarnedUnstable = false;

    // Estado limpo já de cara: em vez de deixar o último frame recebido
    // (agora órfão) na tela até a negociação nova terminar (ou pior, nunca
    // terminar), volta pro placeholder de "aguardando compartilhamento" na
    // hora.
    videoEl.srcObject = null;
    setScreenPlaceholderVisible(true);
    if (window.setScreenActive) window.setScreenActive(false);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    spectatorPc = pc;

    function stopReceiving() {
        videoEl.srcObject = null;
        setScreenPlaceholderVisible(true);
        if (window.setScreenActive) {
            window.setScreenActive(false);
        }
        // Se o Espectador estava em tela cheia (ou com a tela escondida)
        // quando o Host parou de compartilhar, não faz sentido continuar
        // exibindo isso — sai da tela cheia sozinho; o modo "esconder tela"
        // já se resolve sozinho em updateViewerLayout (só tem efeito
        // enquanto screenActive é true).
        if (window.exitScreenFullscreen) {
            window.exitScreenFullscreen();
        }
    }

    pc.ontrack = (event) => {
        videoEl.srcObject = event.streams[0];
        setScreenPlaceholderVisible(false);
        if (window.setScreenActive) {
            window.setScreenActive(true);
        }

        event.track.addEventListener('ended', stopReceiving);
    };

    // O Espectador só responde (não criou a oferta original), então não
    // pode iniciar um ICE restart sozinho — isso é papel de quem ofertou
    // (o Host, ver initWebRTCHost acima). Aqui só observamos e avisamos:
    // se o Host conseguir recuperar, o próprio restart dele já resolve dos
    // dois lados; se a rede do Espectador é que caiu de vez, é a
    // reconexão geral da página (room-init.js) que vai trazê-lo de volta,
    // chamando initWebRTCSpectator de novo.
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') {
            hasWarnedUnstable = false;
            return;
        }
        if ((state === 'disconnected' || state === 'failed') && !hasWarnedUnstable) {
            hasWarnedUnstable = true;
            console.warn(`RoomsCode: conexão de vídeo com o host degradou (${state}).`);
            if (window.showToast) {
                window.showToast(window.t('room.video_connection_unstable'), 'error');
            }
        }
    };

    // Sinal explícito do Host (via signaling.py) de que ele parou de
    // compartilhar — não depende do evento 'ended' da track, que pode não
    // disparar de forma confiável dependendo do navegador.
    spectatorScreenShareStoppedHandler = stopReceiving;
    socket.on('screen_share_stopped', spectatorScreenShareStoppedHandler);

    pc.onicecandidate = (event) => {
        if (event.candidate && roomState.hostSid) {
            socket.emit('webrtc_signal', {
                target_sid: roomState.hostSid,
                signal: { candidate: event.candidate },
            });
        }
    };

    spectatorWebrtcSignalHandler = async (data) => {
        const { sender_sid: senderSid, signal } = data;
        roomState.hostSid = senderSid;

        if (signal.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('webrtc_signal', { target_sid: senderSid, signal: answer });
        } else if (signal.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    };
    socket.on('webrtc_signal', spectatorWebrtcSignalHandler);
}

window.initWebRTCHost = initWebRTCHost;
window.initWebRTCSpectator = initWebRTCSpectator;