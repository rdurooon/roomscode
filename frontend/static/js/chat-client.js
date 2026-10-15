// Formato do comando de código: !code(linha, arquivo) — ex: !code(23, main.py) — ou, para várias linhas,
// !code(inicio~fim, arquivo) — ex: !code(1~12, main.py). Grupos: 1 = linha (ou início), 2 = fim (opcional), 3 = arquivo.
const CODE_REF_PATTERN = /!code\(\s*(\d+)(?:\s*[~-]\s*(\d+))?\s*,\s*([^)]+)\)/g;

/** Linha inicial e final de uma citação já casada por CODE_REF_PATTERN (início maior que o fim vira o inverso). */
function codeRefLines(match) {
    const first = parseInt(match[1], 10);
    const second = match[2] !== undefined ? parseInt(match[2], 10) : first;
    return { start: Math.min(first, second), end: Math.max(first, second) };
}

// Formato do comando de menção: !user(nome) — ex: !user(Fulano)
const USER_MENTION_PATTERN = /!user\(\s*([^)]+)\)/g;

/**
 * Constrói um regex que só casa "@" seguido de um nome que EXISTA de
 * verdade entre os participantes atuais da sala — assim conseguimos
 * suportar nomes com espaço (ex: "Maria Clara") sem exigir um delimitador
 * de fechamento como o "!user(...)" tem. Nomes mais longos entram primeiro
 * na alternância, pra "Ana Paula" não ser cortado em só "Ana" quando os
 * dois existem na sala.
 */
function buildAtMentionPattern(names) {
    if (!names || !names.length) return null;
    const sorted = [...names].sort((a, b) => b.length - a.length);
    const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Mesma regra do servidor (que decide quem recebe o aviso sonoro): sem diferenciar maiúsculas e sem letra,
    // número ou "_" logo depois do nome ("@Anabela" não é uma menção a "Ana").
    return new RegExp(`@(${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

/** True se o caractere logo antes de `index` for letra, número ou "_" (aí o "@" faz parte de outra palavra, como em "a@Ana"). */
function isWordCharBefore(text, index) {
    if (index <= 0) return false;
    const previous = Array.from(text.slice(Math.max(0, index - 2), index)).pop();
    return /[\p{L}\p{N}_]/u.test(previous);
}

function findAllChatMatches(text) {
    const matches = [];
    let m;

    CODE_REF_PATTERN.lastIndex = 0;
    while ((m = CODE_REF_PATTERN.exec(text)) !== null) {
        const lines = codeRefLines(m);
        matches.push({
            index: m.index,
            end: CODE_REF_PATTERN.lastIndex,
            type: 'code',
            lineNumber: lines.start,
            endLineNumber: lines.end,
            filename: m[3].trim(),
        });
    }

    USER_MENTION_PATTERN.lastIndex = 0;
    while ((m = USER_MENTION_PATTERN.exec(text)) !== null) {
        matches.push({
            index: m.index,
            end: USER_MENTION_PATTERN.lastIndex,
            type: 'mention',
            name: m[1].trim(),
        });
    }

    const names = (window.getParticipantNames && window.getParticipantNames()) || [];
    const atPattern = buildAtMentionPattern(names);
    if (atPattern) {
        atPattern.lastIndex = 0;
        while ((m = atPattern.exec(text)) !== null) {
            if (isWordCharBefore(text, m.index)) continue;
            matches.push({
                index: m.index,
                end: atPattern.lastIndex,
                type: 'mention',
                name: m[1],
            });
        }
    }

    matches.sort((a, b) => a.index - b.index);

    // Remove sobreposições (não deveria acontecer na prática, já que cada
    // padrão começa com um marcador diferente, mas por segurança).
    const filtered = [];
    let lastEnd = 0;
    matches.forEach((match) => {
        if (match.index >= lastEnd) {
            filtered.push(match);
            lastEnd = match.end;
        }
    });
    return filtered;
}

function initChat(socket, roomState) {
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const messagesBox = document.getElementById('chat-messages');

    function renderMessageBody(container, text) {
        const matches = findAllChatMatches(text);
        let lastIndex = 0;

        matches.forEach((match) => {
            if (match.index > lastIndex) {
                container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            if (match.type === 'code') {
                const lines = (window.getFileLinesForFilename && window.getFileLinesForFilename(match.filename)) || null;

                const isRange = match.endLineNumber > match.lineNumber;
                const lineTag = isRange ? `L${match.lineNumber}~L${match.endLineNumber}` : `L${match.lineNumber}`;

                let label;
                let resolved = false;
                if (!lines) {
                    label = window.t('chat.chip_file_not_found', { filename: match.filename });
                } else if (match.lineNumber < 1 || match.endLineNumber > lines.length) {
                    const badLine = match.lineNumber < 1 ? match.lineNumber : match.endLineNumber;
                    label = window.t('chat.chip_line_not_found', { filename: match.filename, line: badLine });
                } else {
                    // Várias linhas: o texto mostrado é o da primeira linha citada.
                    label = `${match.filename} ${lineTag}: ${lines[match.lineNumber - 1].trim()}`;
                    resolved = true;
                }

                const chip = document.createElement('span');
                chip.className = 'chat-quote';
                chip.textContent = label;

                // Citação válida: clicar leva direto à linha, no arquivo citado
                // (troca de aba se preciso). Só é conferida de novo no clique,
                // porque o Host pode ter fechado o arquivo ou mudado o código.
                if (resolved) {
                    const goToLine = () => {
                        if (!window.goToCodeLine) return;
                        if (!window.goToCodeLine(match.filename, match.lineNumber, match.endLineNumber) && window.showToast) {
                            window.showToast(
                                window.t('chat.goto_unavailable', { filename: match.filename, line: match.lineNumber }),
                                'error'
                            );
                        }
                    };
                    chip.classList.add('chat-quote-clickable');
                    chip.tabIndex = 0;
                    chip.setAttribute('role', 'button');
                    chip.title = window.t('chat.chip_goto_tooltip');
                    chip.addEventListener('click', goToLine);
                    chip.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            goToLine();
                        }
                    });
                }
                container.appendChild(chip);
            } else if (match.type === 'mention') {
                const isSelf = !!(roomState.name && match.name.toLowerCase() === roomState.name.toLowerCase());
                const chip = document.createElement('span');
                chip.className = 'chat-mention' + (isSelf ? ' chat-mention-self' : '');
                chip.textContent = `@${match.name}`;
                container.appendChild(chip);
            }

            lastIndex = match.end;
        });

        if (lastIndex < text.length) {
            container.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
    }

    socket.on('chat_message', (data) => {
        const el = document.createElement('div');
        el.className = 'chat-message';

        const senderEl = document.createElement('strong');
        senderEl.textContent = `${data.sender}: `;
        el.appendChild(senderEl);

        renderMessageBody(el, data.message);

        messagesBox.appendChild(el);
        messagesBox.scrollTop = messagesBox.scrollHeight;
    });

    // O servidor manda este evento só para quem foi mencionado nesta mensagem.
    socket.on('chat_mention', () => {
        if (window.playMentionSound) window.playMentionSound();
    });

    socket.on('chat_rate_limited', (data) => {
        if (window.showToast) {
            const message = window.t('socket.' + data.code.toLowerCase(), { max_chars: data.max_chars });
            window.showToast(message, 'error');
        }
    });

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const message = input.value.trim();
        if (!message || !roomState.code) return;

        // Chat restrito pelo Host (o servidor também barra — ver chat.py).
        if (roomState.chatMuted) {
            if (window.showToast) window.showToast(window.t(roomState.chatMutedAll ? 'socket.chat_all_muted' : 'socket.chat_muted'), 'error');
            return;
        }

        // Valida ANTES de enviar: se alguma citação referenciar um arquivo
        // desconhecido ou uma linha que não existe, bloqueia o envio,
        // limpa o campo e mostra um toast — em vez de mandar a mensagem.
        const invalidRefs = [];
        let match;
        CODE_REF_PATTERN.lastIndex = 0;
        while ((match = CODE_REF_PATTERN.exec(message)) !== null) {
            const { start, end } = codeRefLines(match);
            const filename = match[3].trim();
            const lines = (window.getFileLinesForFilename && window.getFileLinesForFilename(filename)) || null;

            if (!lines) {
                invalidRefs.push(window.t('chat.invalid_ref_file_not_found', { filename }));
            } else if (start < 1 || end > lines.length) {
                const badLine = start < 1 ? start : end;
                invalidRefs.push(window.t('chat.invalid_ref_line_out_of_range', { filename, line: badLine, total: lines.length }));
            }
        }

        if (invalidRefs.length > 0) {
            if (window.showToast) {
                window.showToast(window.t('chat.invalid_references_toast', { refs: invalidRefs.join(', ') }), 'error');
            }
            input.value = '';
            return;
        }

        socket.emit('chat_message', {
            room_code: roomState.code,
            sender: roomState.name || (roomState.isHost ? window.t('home.host_button') : window.t('home.spectator_button')),
            message,
        });

        input.value = '';
    });
}
