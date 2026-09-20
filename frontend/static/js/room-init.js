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
    let screenActive = false;
    let codeActive = false;

    function updateViewerLayout() {
        if (roomState.isHost || !viewerGrid) return; // regra vale só pro Espectador
        viewerGrid.classList.toggle('screen-only', screenActive && !codeActive);
        viewerGrid.classList.toggle('code-only', codeActive && !screenActive);
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
            socket.emit('spectator_join_room', { room_code: code, name });
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
        // extensão") — não mostramos o valor real em nenhum estado, então
        // não há texto pra atualizar aqui; só o clique (abaixo) usa o
        // valor de verdade em roomState.extToken.
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
        window.setExtensionConnected(!!data.extension_connected);

        // Sempre seguro chamar de novo (só recalcula o painel a partir do
        // estado recebido) — ao contrário de initChat, não registra
        // listener nenhum, então não duplica nada numa reconexão que não
        // passou por F5.
        if (window.loadInitialTabs) {
            window.loadInitialTabs(data.tabs, data.host_cursor);
        }

        // Roda em toda reconexão do Host (F5 ou não), reconstruindo a conexão de cada espectador já na sala.
        if (window.initWebRTCHost) {
            window.initWebRTCHost(socket, roomState);
            (data.spectator_sids || []).forEach((spectatorSid) => {
                if (window.onSpectatorJoined) window.onSpectatorJoined(spectatorSid);
            });
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
            // Reconstrói a conexão de vídeo, já que o Host monta uma nova pra este espectador ao reconectar.
            if (window.initWebRTCSpectator) {
                window.initWebRTCSpectator(socket, roomState);
            }
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

        hostDisplayName = data.host_name || null;
        updateParticipantNames();
        setSpectatorCodeVisible(!!data.code_visible_to_spectators);

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
                socket.emit('spectator_join_room', { room_code: stored.code, name: stored.name });
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
        if (roomState.isHost && window.onSpectatorJoined) {
            window.onSpectatorJoined(data.sid);
        }
    });

    socket.on('spectator_left', (data) => {
        updateSpectatorList(data.spectators);
        // Fecha a RTCPeerConnection dedicada a esse espectador, evitando conexão órfã.
        if (roomState.isHost && window.onSpectatorLeft) {
            window.onSpectatorLeft(data.sid);
        }
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

    // ---- Código da sala: olho revela/borra, clique copia ----
    const eyeToggleBtn = document.getElementById('eye-toggle-btn');
    const roomCodeWrapper = document.getElementById('room-code-wrapper');
    const roomCodePill = document.getElementById('room-code-pill');

    if (eyeToggleBtn && roomCodeWrapper) {
        eyeToggleBtn.addEventListener('click', () => {
            roomCodeWrapper.classList.toggle('revealed');
        });
    }

    // ---- Token da extensão VS Code: rótulo fixo, não afetado pelo botão
    // de olho (só o código da sala é revelado/borrado). Clique copia o
    // token de verdade pro clipboard, separado do código de sala. ----
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

    // ---- Host: liberar/bloquear espectadores verem o código da sala ----
    const visibilityToggleBtn = document.getElementById('visibility-toggle-btn');
    let codeVisibleToSpectators = false;

    if (visibilityToggleBtn) {
        visibilityToggleBtn.addEventListener('click', () => {
            codeVisibleToSpectators = !codeVisibleToSpectators;
            visibilityToggleBtn.classList.toggle('unlocked', codeVisibleToSpectators);
            visibilityToggleBtn.title = codeVisibleToSpectators
                ? window.t('room.visibility_unlock_tooltip')
                : window.t('room.visibility_lock_tooltip');

            if (roomState.code) {
                socket.emit('set_code_visibility', {
                    room_code: roomState.code,
                    visible: codeVisibleToSpectators,
                });
            }
        });
    }

    // ---- Espectador: código da sala aparece quando o Host libera ----
    const spectatorCodeWrapper = document.getElementById('spectator-room-code-wrapper');
    const spectatorCodePill = document.getElementById('spectator-room-code-pill');

    function setSpectatorCodeVisible(visible) {
        if (!spectatorCodeWrapper) return;
        spectatorCodeWrapper.style.display = visible ? 'flex' : 'none';
        if (visible && roomState.code) {
            const textEl = document.getElementById('spectator-room-code-text');
            if (textEl) textEl.textContent = roomState.code;
        }
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

    socket.on('code_visibility_changed', (data) => setSpectatorCodeVisible(!!data.visible));

    // ---- Botão de compartilhar: copia um link curto (origem + código da
    // sala) que leva quem clicar direto pro fluxo de Espectador, com o
    // código já preenchido (ver backend/routes/room_link.py e o
    // value="{{ prefill_code }}" do modal-code-input). Existe pro Host
    // sempre e pro Espectador só quando o código está liberado — mesmo id
    // nos dois lados do template, só um deles é renderizado por vez. ----
    const shareLinkBtn = document.getElementById('share-room-link-btn');
    if (shareLinkBtn) {
        shareLinkBtn.addEventListener('click', async () => {
            if (!roomState.code) return;
            const link = `${window.location.origin}/${roomState.code}`;
            const ok = await copyTextToClipboard(link);
            if (window.showToast) {
                window.showToast(
                    ok ? window.t('room.share_link_copied') : window.t('room.share_link_copy_failed'),
                    ok ? 'success' : 'error'
                );
            }
        });
    }

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

    function updateSpectatorList(spectators) {
        currentSpectatorNames = spectators;
        const list = document.getElementById('spectator-list');
        list.innerHTML = '';
        spectators.forEach((name) => {
            const li = document.createElement('li');
            li.textContent = name;
            list.appendChild(li);
        });
        document.getElementById('spectators-heading').textContent = window.t('room.spectators_heading', { count: spectators.length });
    }

    initFileSync(socket);
})();
