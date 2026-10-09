(function () {
    // Configuração explícita do socket.io do navegador (Host e Espectador):
    // mantém o fallback polling->websocket padrão (forçar só websocket
    // quebra em redes de instituição/escola que bloqueiam upgrade — ver
    // aprendizado registrado sobre WebRTC em NAT restritivo, o mesmo tipo
    // de rede também costuma limitar WebSocket puro), mas com timeout de
    // conexão inicial mais curto e parâmetros de reconexão explícitos, em
    // vez de depender dos defaults implícitos da lib.
    const socket = io({
        timeout: 10000,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
    });
    const roomState = {
        code: null,
        isHost: document.body.dataset.roomRole === 'host',
        name: '',
        hostSid: null,
        screenSharing: false,
        chatMuted: false,
    };

    // ---- Persistência de sessão (sessionStorage) pra sobreviver a quedas
    // de conexão e recarregamentos de página (F5) sem perder a sala ----
    //
    // Host: guarda o código da sala + o host_session_token (nunca visto por
    // espectadores) pra provar depois de uma queda que é o mesmo Host
    // voltando (ver handle_host_reconnect no backend). Espectador: guarda
    // só código + nome, pra se reconectar sozinho (sem token: não há nada
    // sensível em ser espectador de novo) depois de uma queda breve, sem
    // precisar digitar tudo de novo.
    const HOST_SESSION_KEY = 'roomscode_host_session';
    const SPECTATOR_SESSION_KEY = 'roomscode_spectator_session';

    function saveHostSession(code, token) {
        try {
            sessionStorage.setItem(HOST_SESSION_KEY, JSON.stringify({ code, token }));
        } catch (e) { /* sessionStorage indisponível (modo privado etc.) — degrada bem, só sem auto-reconexão */ }
    }
    function loadHostSession() {
        try {
            const raw = sessionStorage.getItem(HOST_SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function clearHostSession() {
        try { sessionStorage.removeItem(HOST_SESSION_KEY); } catch (e) { /* ignora */ }
    }

    function saveSpectatorSession(code, name) {
        try {
            sessionStorage.setItem(SPECTATOR_SESSION_KEY, JSON.stringify({ code, name }));
        } catch (e) { /* ignora */ }
    }
    function loadSpectatorSession() {
        try {
            const raw = sessionStorage.getItem(SPECTATOR_SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function clearSpectatorSession() {
        try { sessionStorage.removeItem(SPECTATOR_SESSION_KEY); } catch (e) { /* ignora */ }
    }

    // Id anônimo deste navegador, mandado ao entrar como Espectador. Serve só
    // pro backend reconhecer quem volta depois de uma expulsão/restrição de
    // chat (ver RoomManager.add_spectator) — fica no localStorage pra valer
    // também em outra aba, e nunca é exibido nem repassado a outros usuários.
    const CLIENT_ID_KEY = 'roomscode_client_id';
    const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
    let memoryClientId = null;

    function generateClientId() {
        const c = window.crypto;
        if (c && c.randomUUID) return c.randomUUID();
        if (c && c.getRandomValues) {
            return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
        }
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    }

    function getClientId() {
        try {
            const stored = localStorage.getItem(CLIENT_ID_KEY);
            if (stored && CLIENT_ID_PATTERN.test(stored)) return stored;
            const fresh = generateClientId();
            localStorage.setItem(CLIENT_ID_KEY, fresh);
            return fresh;
        } catch (e) {
            // localStorage indisponível: o id vale só enquanto esta página estiver aberta.
            if (!memoryClientId) memoryClientId = generateClientId();
            return memoryClientId;
        }
    }

    // true depois que o painel (chat, WebRTC) já foi inicializado uma vez
    // nesta instância de página — evita registrar os listeners de novo numa
    // reconexão que NÃO passou por um F5 (o socket.io reaproveita o mesmo
    // objeto `socket`, então os listeners de chat/webrtc antigos continuam
    // válidos; inicializar de novo os duplicaria).
    let roomSetupDone = false;

    // ---- Banner persistente (criado dinamicamente, mesmo padrão do
    // toast.js) pra avisar Espectadores que o Host caiu, com contagem
    // regressiva — diferente de um toast, que sozinho já teria desaparecido
    // muito antes do prazo de graça acabar. ----
    let graceCountdownInterval = null;

    function ensureReconnectBanner() {
        let banner = document.getElementById('reconnect-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'reconnect-banner';
            banner.className = 'reconnect-banner';
            banner.innerHTML = '<span class="reconnect-banner-text"></span>';
            document.body.appendChild(banner);
        }
        return banner;
    }

    function showHostGraceBanner(graceSeconds) {
        const banner = ensureReconnectBanner();
        const textEl = banner.querySelector('.reconnect-banner-text');
        let remaining = Math.max(0, Math.round(graceSeconds));

        const render = () => {
            textEl.textContent = remaining > 0
                ? window.t('socket.host_disconnected_grace_countdown', { remaining })
                : window.t('socket.host_disconnected_grace_waiting');
        };

        banner.style.display = 'flex';
        render();

        clearInterval(graceCountdownInterval);
        graceCountdownInterval = setInterval(() => {
            remaining -= 1;
            render();
            if (remaining <= 0) clearInterval(graceCountdownInterval);
        }, 1000);
    }

    function hideReconnectBanner() {
        clearInterval(graceCountdownInterval);
        const banner = document.getElementById('reconnect-banner');
        if (banner) banner.style.display = 'none';
    }

    // ---- Modal: passo extra de "reconectando", pra reconexão do Host
    // depois de uma queda (ou de um F5) não obrigar a preencher o
    // formulário de criação de sala de novo. Criado dinamicamente dentro do
    // card do modal existente, sem precisar tocar no template. ----
    function ensureReconnectingStep() {
        let el = document.getElementById('modal-step-reconnecting');
        if (!el) {
            const card = modal ? modal.querySelector('.modal-card') : null;
            if (!card) return null;
            el = document.createElement('div');
            el.id = 'modal-step-reconnecting';
            el.style.display = 'none';
            el.innerHTML = `<p class="reconnecting-text">${window.t('socket.reconnecting_to_room')}</p>`;
            card.appendChild(el);
        }
        return el;
    }

    function showHostReconnectingUI() {
        const el = ensureReconnectingStep();
        if (stepForm) stepForm.style.display = 'none';
        if (stepCode) stepCode.style.display = 'none';
        if (el) el.style.display = 'block';
        if (modal) modal.style.display = 'flex';
    }

    function hideHostReconnectingUI() {
        const el = document.getElementById('modal-step-reconnecting');
        if (el) el.style.display = 'none';
    }

    const modal = document.getElementById('join-modal');
    const stepForm = document.getElementById('modal-step-input');
    const stepCode = document.getElementById('modal-step-code');
    const nameInput = document.getElementById('modal-name-input');
    const codeInput = document.getElementById('modal-code-input');
    const errorEl = document.getElementById('modal-error');
    const enterRoomBtn = document.getElementById('modal-enter-room-btn');

    // ---- Estado de tela/código (só usado pro redimensionamento no Espectador) ----
    const viewerGrid = document.getElementById('viewer-grid');
    const screenPanel = document.getElementById('screen-panel');
    const showHostScreenBtn = document.getElementById('show-host-screen-btn');
    let screenActive = false;
    let codeActive = false;
    // "Esconder tela": estado puramente local a este Espectador (não
    // sincroniza com o Host nem com outros Espectadores) — só reorganiza o
    // layout pra mostrar somente o painel de código, como se o Host não
    // estivesse compartilhando tela nenhuma. Só tem efeito de fato enquanto
    // screenActive também é true; se o Host parar de compartilhar de
    // verdade, o botão de restaurar (e o efeito) somem sozinhos.
    let manualScreenHidden = false;

    function updateViewerLayout() {
        if (roomState.isHost || !viewerGrid) return; // regra vale só pro Espectador
        if (screenPanel) screenPanel.classList.toggle('has-video', screenActive);
        const effectiveHideScreen = manualScreenHidden && screenActive;
        viewerGrid.classList.toggle('screen-only', screenActive && !codeActive && !effectiveHideScreen);
        viewerGrid.classList.toggle('code-only', (codeActive && !screenActive) || effectiveHideScreen);
        if (showHostScreenBtn) showHostScreenBtn.style.display = effectiveHideScreen ? 'flex' : 'none';
    }

    window.setScreenActive = (active) => {
        screenActive = active;
        updateViewerLayout();
    };
    const codePanel = document.getElementById('code-panel');
    window.setCodeActive = (active) => {
        codeActive = active;
        updateViewerLayout();
        // Alterna o cabeçalho fixo + <pre> pelo placeholder de "nenhum
        // código compartilhado" (ver comentário no CSS sobre a barrinha
        // vazia que isso substitui).
        if (codePanel) codePanel.classList.toggle('code-panel-empty', !active);
    };

    // ---- Controles da tela compartilhada (Espectador): "Esconder tela" e
    // "Tela cheia". A UI (cápsula, botão de restaurar) só existe no
    // template do Espectador — no Host, os getElementById abaixo retornam
    // null e nenhum listener é registrado. ----
    const hideScreenBtn = document.getElementById('hide-screen-toggle-btn');
    if (hideScreenBtn) {
        hideScreenBtn.addEventListener('click', () => {
            manualScreenHidden = true;
            updateViewerLayout();
        });
    }
    if (showHostScreenBtn) {
        showHostScreenBtn.addEventListener('click', () => {
            manualScreenHidden = false;
            updateViewerLayout();
        });
    }

    const fullscreenBtn = document.getElementById('fullscreen-toggle-btn');
    const exitFullscreenBtn = document.getElementById('exit-fullscreen-btn');

    // Fullscreen API nativa direto no #screen-panel (assim o vídeo, e só
    // ele, cobre o monitor inteiro — ver regras :fullscreen no CSS). Esc
    // sai sozinho por comportamento padrão do navegador; só escutamos
    // 'fullscreenchange' pra manter o botão de sair coerente com o estado
    // real (inclusive se o navegador sair por conta própria).
    function requestScreenFullscreen() {
        if (!screenPanel) return;
        const req = screenPanel.requestFullscreen || screenPanel.webkitRequestFullscreen;
        if (!req) return;
        req.call(screenPanel).catch((err) => {
            console.error('RoomsCode: falha ao entrar em tela cheia.', err);
        });
    }
    function exitScreenFullscreen() {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (document.fullscreenElement && exit) exit.call(document);
    }
    // Exposto pro webrtc-client.js: se o Host parar de compartilhar
    // enquanto o Espectador está em tela cheia, não faz sentido continuar
    // nela mostrando uma tela preta.
    window.exitScreenFullscreen = exitScreenFullscreen;

    if (fullscreenBtn) fullscreenBtn.addEventListener('click', requestScreenFullscreen);
    if (exitFullscreenBtn) exitFullscreenBtn.addEventListener('click', exitScreenFullscreen);

    // Botão "Sair de tela cheia": aparece de uma vez ao mexer o mouse, some
    // deslizando pra baixo depois de um tempo parado. A classe
    // 'transition-visibility' só entra na hora de esconder (dá o efeito de
    // slide) e sai antes de mostrar de novo, pra essa aparição ser
    // instantânea em vez de animada.
    let hideExitBtnTimeout = null;
    function showExitFullscreenBtn() {
        if (!exitFullscreenBtn) return;
        exitFullscreenBtn.classList.remove('transition-visibility');
        exitFullscreenBtn.classList.add('visible');
        clearTimeout(hideExitBtnTimeout);
        hideExitBtnTimeout = setTimeout(() => {
            exitFullscreenBtn.classList.add('transition-visibility');
            exitFullscreenBtn.classList.remove('visible');
        }, 2500);
    }

    document.addEventListener('fullscreenchange', () => {
        const isFullscreen = document.fullscreenElement === screenPanel;
        if (isFullscreen) {
            showExitFullscreenBtn();
        } else {
            clearTimeout(hideExitBtnTimeout);
            if (exitFullscreenBtn) exitFullscreenBtn.classList.remove('visible', 'transition-visibility');
        }
    });

    if (screenPanel) {
        screenPanel.addEventListener('mousemove', () => {
            if (document.fullscreenElement === screenPanel) showExitFullscreenBtn();
        });
    }

    // ---- Host: painel vazio muda de mensagem conforme a extensão do VS Code está ou não conectada ----
    const codeEmptyMessage = document.getElementById('code-empty-state-message');
    const downloadTriggerWrap = document.getElementById('code-panel-download-trigger-wrap');
    window.setExtensionConnected = (connected) => {
        if (!codeEmptyMessage || !downloadTriggerWrap) return;
        codeEmptyMessage.textContent = connected
            ? window.t('room.waiting_for_file_extension_connected')
            : window.t('room.no_code_shared');
        downloadTriggerWrap.style.display = connected ? 'none' : '';
    };

    socket.on('extension_status', (data) => {
        if (roomState.isHost) window.setExtensionConnected(!!data.connected);
    });

    // ---- Voltar pra home a partir da tela de nome/código ----
    const modalBackBtn = document.getElementById('modal-back-btn');
    if (modalBackBtn) {
        modalBackBtn.addEventListener('click', () => {
            window.location.href = '/';
        });
    }

    // ---- Modal: é um <form>, então Enter já confirma naturalmente ----
    stepForm.addEventListener('submit', (event) => {
        event.preventDefault();

        const name = nameInput.value.trim();
        if (!name) {
            errorEl.textContent = window.t('room.name_required_error');
            return;
        }
        roomState.name = name;
        errorEl.textContent = '';

        if (roomState.isHost) {
            socket.emit('host_create_room', { name });
        } else {
            const code = (codeInput.value || '').trim().toUpperCase();
            if (!code) {
                errorEl.textContent = window.t('room.room_code_required_error');
                return;
            }
            socket.emit('spectator_join_room', { room_code: code, name, client_id: getClientId() });
        }
    });

    // Exige o modal (overlay inteiro) visível, não só o step do código, senão Enter fora do modal também seria capturado.
    if (enterRoomBtn) {
        enterRoomBtn.addEventListener('click', () => {
            stepCode.style.display = 'none';
            modal.style.display = 'none';
        });

        document.addEventListener('keydown', (event) => {
            const modalVisible = modal.style.display !== 'none';
            const stepCodeVisible = stepCode.style.display !== 'none';
            if (event.key === 'Enter' && modalVisible && stepCodeVisible) {
                event.preventDefault();
                enterRoomBtn.click();
            }
        });
    }

    // ---- Host: sala criada, mostra o código pra repassar ----
    socket.on('room_created', (data) => {
        roomState.code = data.code;
        roomState.extToken = data.ext_token || '';
        saveHostSession(data.code, data.host_session_token || '');
        document.getElementById('room-code-display').textContent = data.code;
        document.getElementById('room-code-text').textContent = data.code;
        // O rótulo do token da extensão é fixo ("Copiar código da
        // extensão") — não mostramos o valor real, então não há texto pra
        // atualizar aqui; só o clique (abaixo) usa o valor de verdade em
        // roomState.extToken.
        stepForm.style.display = 'none';
        stepCode.style.display = 'block';

        hostDisplayName = roomState.name;
        updateParticipantNames();

        initChat(socket, roomState);
        if (window.initWebRTCHost) {
            window.initWebRTCHost(socket, roomState);
        }
        roomSetupDone = true;
    });

    // ---- Host: tentativa de reconexão (após queda ou F5) a uma sala em
    // estado de graça — ver comentário grande no `connect` handler abaixo
    // sobre quando isso é disparado. ----
    socket.on('host_reconnect_success', (data) => {
        hideHostReconnectingUI();
        roomState.code = data.code;
        roomState.extToken = data.ext_token || '';
        document.getElementById('room-code-display').textContent = data.code;
        document.getElementById('room-code-text').textContent = data.code;
        stepForm.style.display = 'none';
        stepCode.style.display = 'none';
        if (modal) modal.style.display = 'none';

        hostDisplayName = data.host_name || hostDisplayName;
        updateParticipantNames();
        updateSpectatorList(data.spectators || []);
        updateSpectatorRoster(data.roster || []);
        window.setExtensionConnected(!!data.extension_connected);

        // Sempre seguro chamar de novo (só recalcula o painel a partir do
        // estado recebido) — ao contrário de initChat, não registra
        // listener nenhum, então não duplica nada numa reconexão que não
        // passou por F5.
        if (window.loadInitialTabs) {
            window.loadInitialTabs(data.tabs, data.host_cursor);
        }

        // Roda em toda reconexão do Host (F5 ou não). Não precisa reconstruir nada por espectador:
        // quem estiver esperando a tela pede a oferta de novo quando o Host voltar a compartilhar.
        if (window.initWebRTCHost) {
            window.initWebRTCHost(socket, roomState);
        }

        if (!roomSetupDone) {
            // F5 (ou aba nova): esta instância de página nunca inicializou
            // o chat — precisa fazer isso agora, como se fosse
            // `room_created`.
            initChat(socket, roomState);
            roomSetupDone = true;
            if (window.showToast) window.showToast(window.t('socket.room_restored'), 'success');
        } else {
            // Reconexão dentro da mesma página (o socket.io reconectou
            // sozinho depois de uma queda breve) — o chat já estava
            // rodando com o mesmo objeto `socket`, então não é preciso (nem
            // seria seguro) inicializar de novo.
            if (window.showToast) window.showToast(window.t('socket.reconnected_to_room'), 'success');
        }
    });

    socket.on('host_reconnect_failed', (data) => {
        hideHostReconnectingUI();
        clearHostSession();
        if (window.showToast) {
            window.showToast(window.t('socket.' + data.code.toLowerCase()), 'error');
        }
        // Sem sala pra voltar: mostra o formulário normal de criação de
        // sala de novo, como se fosse a primeira visita.
        if (errorEl) errorEl.textContent = '';
        if (stepForm) stepForm.style.display = 'block';
        if (stepCode) stepCode.style.display = 'none';
        if (modal) modal.style.display = 'flex';
    });

    // ---- Espectador: avisos sobre o Host cair/reconectar (a sala continua
    // de pé durante o prazo de graça — ver backend/events/presence.py) ----
    socket.on('host_disconnected_grace', (data) => {
        if (!roomState.isHost) {
            showHostGraceBanner(data.grace_seconds);
        }
    });

    socket.on('host_reconnected', () => {
        if (!roomState.isHost) {
            hideReconnectBanner();
            if (window.showToast) window.showToast(window.t('socket.host_reconnected'), 'success');
        }
    });

    // ---- Espectador: erro ou sucesso ao entrar ----
    socket.on('join_error', (data) => {
        // Se essa era uma tentativa de auto-reconexão silenciosa (sala não
        // existe mais mesmo), não faz sentido manter o nome/código antigo
        // guardado pra tentar de novo pra sempre a cada reconexão futura.
        clearSpectatorSession();
        const message = window.t('socket.' + data.code.toLowerCase());
        errorEl.textContent = message;
        if (window.showToast) {
            window.showToast(message, 'error');
        }
    });

    socket.on('joined_room', (data) => {
        roomState.code = data.code;
        saveSpectatorSession(data.code, roomState.name);
        stepCode.style.display = 'none';
        modal.style.display = 'none';
        updateSpectatorList(data.spectators);

        // Quem volta depois de ser expulso (ou restrito) já entra com o chat restrito.
        const wasMuted = roomState.chatMuted;
        setChatMuted(!!data.chat_muted);
        if (roomState.chatMuted && !wasMuted && window.showToast) {
            window.showToast(window.t('socket.chat_restricted_on_join'), 'error');
        }

        hostDisplayName = data.host_name || null;
        updateParticipantNames();
        showSpectatorRoomCode();

        if (window.loadInitialTabs) {
            window.loadInitialTabs(data.tabs, data.host_cursor);
        }

        if (!roomSetupDone) {
            initChat(socket, roomState);
            roomSetupDone = true;
        } else {
            // Reconexão depois de uma queda breve: já estava tudo
            // inicializado, só precisava voltar a fazer parte da sala.
            if (window.showToast) window.showToast(window.t('socket.reconnected_to_room'), 'success');
        }

        // Roda em toda entrada/reentrada na sala (F5 ou reconexão automática do socket.io com sid novo).
        // O servidor informa se o Host já está compartilhando, pra pedir a tela na hora.
        roomState.screenSharing = !!data.screen_sharing;
        if (window.initWebRTCSpectator) {
            window.initWebRTCSpectator(socket, roomState);
        }
    });

    // ---- Reconexão automática (mesma aba) depois de uma queda de rede, OU
    // primeira conexão depois de um F5 quando já havia uma sessão salva ----
    //
    // 'connect' dispara na conexão inicial e em toda reconexão automática; com sessão salva, retoma a sala sozinho.
    socket.on('connect', () => {
        if (roomState.isHost) {
            const stored = loadHostSession();
            if (stored && stored.code && stored.token) {
                showHostReconnectingUI();
                socket.emit('host_reconnect', { room_code: stored.code, host_session_token: stored.token });
            }
        } else {
            const stored = loadSpectatorSession();
            if (stored && stored.code && stored.name) {
                roomState.name = stored.name;
                socket.emit('spectator_join_room', { room_code: stored.code, name: stored.name, client_id: getClientId() });
            }
        }
    });

    socket.io.on('reconnect_attempt', (attempt) => {
        if (attempt === 1 && window.showToast) {
            window.showToast(window.t('socket.connection_lost_retrying'), 'error');
        }
    });

    socket.io.on('reconnect_failed', () => {
        if (window.showToast) {
            window.showToast(window.t('socket.reconnect_failed_reload'), 'error');
        }
    });

    socket.on('spectator_joined', (data) => {
        updateSpectatorList(data.spectators);
    });

    socket.on('spectator_left', (data) => {
        updateSpectatorList(data.spectators);
        // Fecha a RTCPeerConnection dedicada a esse espectador, evitando conexão órfã.
        if (roomState.isHost && window.onSpectatorLeft) {
            window.onSpectatorLeft(data.sid);
        }
    });

    // ---- Moderação (ações do Host sobre um espectador) ----

    // Só o Host recebe: lista de espectadores com sid e estado do chat.
    socket.on('spectator_roster', (data) => {
        if (roomState.isHost) updateSpectatorRoster((data && data.spectators) || []);
    });

    // Espectador: o Host restringiu ou liberou o chat dele.
    socket.on('chat_muted_changed', (data) => {
        if (roomState.isHost) return;
        const muted = !!(data && data.muted);
        const changed = muted !== roomState.chatMuted;
        setChatMuted(muted);
        if (changed && window.showToast) {
            window.showToast(
                window.t(muted ? 'socket.chat_muted_by_host' : 'socket.chat_unmuted_by_host'),
                muted ? 'error' : 'success'
            );
        }
    });

    // Espectador: o Host expulsou da sala. Ele pode voltar quando quiser (já
    // com o chat restrito), então só limpa a sessão guardada — senão a
    // reconexão automática o colocaria de volta na sala na mesma hora.
    socket.on('kicked', (data) => {
        if (roomState.isHost) return;
        hideReconnectBanner();
        clearSpectatorSession();
        clearHostSession();
        const video = document.getElementById('video-display');
        if (video) video.srcObject = null;
        if (window.showToast) {
            window.showToast(window.t('socket.' + String((data && data.code) || 'KICKED_FROM_ROOM').toLowerCase()), 'error');
        }
        socket.disconnect();
        setTimeout(() => {
            window.location.href = '/';
        }, 1800);
    });

    socket.on('host_left', (data) => {
        // A sala acabou de verdade (o Host encerrou de propósito, ou o
        // prazo de graça expirou) — não faz sentido guardar mais nada pra
        // tentar reconectar sozinho depois.
        hideReconnectBanner();
        clearHostSession();
        clearSpectatorSession();
        if (window.showToast) {
            window.showToast(window.t('socket.' + data.code.toLowerCase()), 'error');
        }
        // Dá um tempinho pro toast aparecer antes de redirecionar.
        setTimeout(() => {
            window.location.href = '/';
        }, 1800);
    });

    // ---- Sair da sala (clique na marca "RoomsCode" ou no ícone de saída) ----
    // Popup próprio (mesmo estilo/template do modal de entrada) no lugar
    // do window.confirm padrão do navegador.
    const exitModal = document.getElementById('exit-modal');
    const exitModalMessage = document.getElementById('exit-modal-message');
    const exitCancelBtn = document.getElementById('exit-cancel-btn');
    const exitConfirmBtn = document.getElementById('exit-confirm-btn');

    function openExitModal() {
        if (!exitModal) return;
        exitModalMessage.textContent = roomState.isHost
            ? window.t('room.exit_confirm_message_host')
            : window.t('room.exit_confirm_message_spectator');
        exitModal.style.display = 'flex';
    }

    function closeExitModal() {
        if (exitModal) exitModal.style.display = 'none';
    }

    function performExitRoom() {
        if (roomState.isHost && roomState.code) {
            socket.emit('host_end_room', { room_code: roomState.code });
        }
        // Saída deliberada — nada a reconectar depois, então não deixamos
        // nenhuma sessão pra trás.
        clearHostSession();
        clearSpectatorSession();
        socket.disconnect();
        window.location.href = '/';
    }

    if (exitCancelBtn) exitCancelBtn.addEventListener('click', closeExitModal);
    if (exitConfirmBtn) exitConfirmBtn.addEventListener('click', performExitRoom);
    if (exitModal) {
        // Clicar fora do card (no overlay escuro) também cancela.
        exitModal.addEventListener('click', (event) => {
            if (event.target === exitModal) closeExitModal();
        });
    }
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && exitModal && exitModal.style.display !== 'none') {
            closeExitModal();
        }
    });

    const brandExitBtn = document.getElementById('brand-exit-btn');
    const exitIconBtn = document.getElementById('exit-room-btn');
    if (brandExitBtn) brandExitBtn.addEventListener('click', openExitModal);
    if (exitIconBtn) exitIconBtn.addEventListener('click', openExitModal);

    // ---- Código da sala (Host): sempre visível, clique copia ----
    const roomCodePill = document.getElementById('room-code-pill');

    // ---- Token da extensão VS Code: rótulo fixo. Clique copia o token de
    // verdade pro clipboard, separado do código de sala. ----
    const extTokenPill = document.getElementById('ext-token-pill');
    if (extTokenPill) {
        extTokenPill.addEventListener('click', async () => {
            if (!roomState.extToken) return;
            const ok = await copyTextToClipboard(roomState.extToken);
            if (window.showToast) {
                window.showToast(
                    ok ? window.t('room.ext_token_copied') : window.t('room.ext_token_copy_failed'),
                    ok ? 'success' : 'error'
                );
            }
        });
    }

    // ---- Espectador: código da sala sempre visível depois de entrar ----
    const spectatorCodeWrapper = document.getElementById('spectator-room-code-wrapper');
    const spectatorCodePill = document.getElementById('spectator-room-code-pill');

    function showSpectatorRoomCode() {
        if (!spectatorCodeWrapper) return;
        spectatorCodeWrapper.style.display = 'flex';
        const textEl = document.getElementById('spectator-room-code-text');
        if (textEl && roomState.code) textEl.textContent = roomState.code;
    }

    if (spectatorCodePill) {
        spectatorCodePill.addEventListener('click', async () => {
            if (!roomState.code) return;
            const ok = await copyTextToClipboard(roomState.code);
            if (window.showToast) {
                window.showToast(
                    ok ? window.t('room.room_code_copied') : window.t('room.room_code_copy_failed'),
                    ok ? 'success' : 'error'
                );
            }
        });
    }

    // ---- Botões de compartilhar (.share-link-btn): copiam um link curto
    // (origem + código da sala) que leva quem clicar direto pro fluxo de
    // Espectador, com o código já preenchido (ver
    // backend/routes/room_link.py e o value="{{ prefill_code }}" do
    // modal-code-input). Existem na topbar (Host e Espectador) e no popup
    // de sala criada (Host) — todos com o mesmo comportamento. ----
    async function copyRoomShareLink() {
        if (!roomState.code) return;
        const link = `${window.location.origin}/${roomState.code}`;
        const ok = await copyTextToClipboard(link);
        if (window.showToast) {
            window.showToast(
                ok ? window.t('room.share_link_copied') : window.t('room.share_link_copy_failed'),
                ok ? 'success' : 'error'
            );
        }
    }
    document.querySelectorAll('.share-link-btn').forEach((btn) => {
        btn.addEventListener('click', copyRoomShareLink);
    });

    // ---- Espectador: checkbox de seguir o Host ----
    const followCheckbox = document.getElementById('follow-host-checkbox');
    if (followCheckbox) {
        followCheckbox.addEventListener('change', () => {
            if (window.setFollowHost) {
                window.setFollowHost(followCheckbox.checked);
            }
        });
    }
    window.onFollowHostAutoDisabled = () => {
        if (followCheckbox) followCheckbox.checked = false;
    };

    if (roomCodePill) {
        roomCodePill.addEventListener('click', async () => {
            if (!roomState.code) return;
            const ok = await copyTextToClipboard(roomState.code);
            if (window.showToast) {
                window.showToast(
                    ok ? window.t('room.room_code_copied') : window.t('room.room_code_copy_failed'),
                    ok ? 'success' : 'error'
                );
            }
        });
    }

    let hostDisplayName = null;
    let currentSpectatorNames = [];
    let currentRoster = []; // só no Host: [{ sid, name, muted }]

    function updateParticipantNames() {
        // não-op — só existe pra deixar explícito o ponto de atualização;
        // getParticipantNames() já lê hostDisplayName/currentSpectatorNames
        // diretamente na hora de ser chamada.
    }

    window.getParticipantNames = () => {
        const names = [];
        if (hostDisplayName) names.push(hostDisplayName);
        names.push(...currentSpectatorNames);
        return names;
    };

    function updateSpectatorsHeading(count) {
        document.getElementById('spectators-heading').textContent = window.t('room.spectators_heading', { count });
    }

    function renderSpectatorList(entries) {
        const list = document.getElementById('spectator-list');
        list.innerHTML = '';
        entries.forEach((entry) => {
            const li = document.createElement('li');
            li.textContent = entry.name;
            // Só o Host clica num espectador (abre o menu de moderação); pra
            // isso a entrada precisa do sid, que só vem no roster do Host.
            if (roomState.isHost && entry.sid) {
                li.dataset.sid = entry.sid;
                li.className = 'spectator-item-clickable';
                li.tabIndex = 0;
                li.setAttribute('role', 'button');
                li.addEventListener('click', () => toggleSpectatorMenu(entry.sid, li));
                li.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleSpectatorMenu(entry.sid, li);
                    }
                });
            }
            list.appendChild(li);
        });
        updateSpectatorsHeading(entries.length);
        refreshSpectatorMenu();
    }

    function updateSpectatorList(spectators) {
        currentSpectatorNames = spectators;
        if (roomState.isHost) {
            // A lista do Host vem do roster (com sid) — redesenhar só com
            // nomes aqui apagaria os cliques por um instante. Só o contador muda.
            updateSpectatorsHeading(spectators.length);
            return;
        }
        renderSpectatorList(spectators.map((name) => ({ name })));
    }

    function updateSpectatorRoster(roster) {
        currentRoster = roster;
        currentSpectatorNames = roster.map((entry) => entry.name);
        renderSpectatorList(roster);
    }

    // ---- Host: menu do espectador selecionado (balão = restringir/liberar
    // chat, chute = expulsar) ----
    const spectatorMenu = document.getElementById('spectator-menu');
    const menuMuteBtn = document.getElementById('spectator-menu-mute-btn');
    const menuKickBtn = document.getElementById('spectator-menu-kick-btn');
    let menuSid = null;

    function findSpectatorItem(sid) {
        return Array.from(document.querySelectorAll('#spectator-list li')).find((li) => li.dataset.sid === sid) || null;
    }

    function closeSpectatorMenu() {
        if (!spectatorMenu) return;
        spectatorMenu.hidden = true;
        menuSid = null;
        document.querySelectorAll('#spectator-list li.spectator-item-selected').forEach((li) => {
            li.classList.remove('spectator-item-selected');
        });
    }

    function positionSpectatorMenu(anchor) {
        spectatorMenu.hidden = false; // precisa estar visível pra medir
        const rect = anchor.getBoundingClientRect();
        const width = spectatorMenu.offsetWidth;
        const height = spectatorMenu.offsetHeight;
        const margin = 6;
        const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, margin), window.innerWidth - width - margin);
        // Logo abaixo do nome (não cobre o título do painel); em cima só se não couber.
        const fitsBelow = rect.bottom + 8 + height <= window.innerHeight - margin;
        const top = fitsBelow ? rect.bottom + 8 : Math.max(margin, rect.top - height - 8);
        spectatorMenu.style.left = `${left}px`;
        spectatorMenu.style.top = `${top}px`;
    }

    // Chamado a cada redesenho da lista: mantém o menu aberto no mesmo
    // espectador (e com o estado atualizado) ou fecha se ele saiu da sala.
    function refreshSpectatorMenu() {
        if (!spectatorMenu || !menuSid) return;
        const entry = currentRoster.find((item) => item.sid === menuSid);
        const li = findSpectatorItem(menuSid);
        if (!entry || !li) {
            closeSpectatorMenu();
            return;
        }
        li.classList.add('spectator-item-selected');
        const label = window.t(entry.muted ? 'room.mod_unmute_tooltip' : 'room.mod_mute_tooltip');
        menuMuteBtn.classList.toggle('is-muted', !!entry.muted);
        menuMuteBtn.setAttribute('aria-pressed', entry.muted ? 'true' : 'false');
        menuMuteBtn.title = label;
        menuMuteBtn.setAttribute('aria-label', label);
        positionSpectatorMenu(li);
    }

    function toggleSpectatorMenu(sid, li) {
        if (!spectatorMenu) return;
        if (menuSid === sid) {
            closeSpectatorMenu();
            return;
        }
        document.querySelectorAll('#spectator-list li.spectator-item-selected').forEach((item) => {
            item.classList.remove('spectator-item-selected');
        });
        menuSid = sid;
        refreshSpectatorMenu();
    }

    if (spectatorMenu) {
        const kickLabel = window.t('room.mod_kick_tooltip');
        menuKickBtn.title = kickLabel;
        menuKickBtn.setAttribute('aria-label', kickLabel);

        menuMuteBtn.addEventListener('click', () => {
            const entry = currentRoster.find((item) => item.sid === menuSid);
            if (!entry || !roomState.code) return;
            // O ícone só muda quando o servidor confirma (chega um novo roster).
            socket.emit('host_set_chat_muted', { room_code: roomState.code, sid: entry.sid, muted: !entry.muted });
        });

        menuKickBtn.addEventListener('click', () => {
            if (!menuSid || !roomState.code) return;
            socket.emit('host_kick_spectator', { room_code: roomState.code, sid: menuSid });
            closeSpectatorMenu();
        });

        document.addEventListener('mousedown', (event) => {
            if (!menuSid || spectatorMenu.contains(event.target)) return;
            // Clicar em outro nome da lista troca o alvo (tratado no click do próprio item).
            if (event.target.closest && event.target.closest('#spectator-list li[data-sid]')) return;
            closeSpectatorMenu();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && menuSid) closeSpectatorMenu();
        });
        window.addEventListener('resize', closeSpectatorMenu);
        const spectatorsPanel = document.querySelector('.spectators-panel');
        if (spectatorsPanel) spectatorsPanel.addEventListener('scroll', closeSpectatorMenu);
    }

    // ---- Espectador: chat restrito pelo Host. O servidor é quem barra as
    // mensagens (ver chat.py); isto só deixa a interface coerente. Copiar e
    // baixar o código continuam liberados. ----
    function setChatMuted(muted) {
        roomState.chatMuted = muted;
        const form = document.getElementById('chat-form');
        const input = document.getElementById('chat-input');
        const sendBtn = form ? form.querySelector('button[type="submit"]') : null;
        if (!form || !input) return;
        form.classList.toggle('chat-muted', muted);
        input.disabled = muted;
        if (sendBtn) sendBtn.disabled = muted;
        input.placeholder = window.t(muted ? 'room.chat_muted_placeholder' : 'room.chat_input_placeholder');
        if (muted) input.value = '';
    }
    window.isChatMuted = () => roomState.chatMuted;

    initFileSync(socket);
})();