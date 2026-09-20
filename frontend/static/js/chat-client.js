// Formato do comando de código: !code(linha, arquivo) — ex: !code(23, main.py)
const CODE_REF_PATTERN = /!code\(\s*(\d+)\s*,\s*([^)]+)\)/g;

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
    return new RegExp(`@(${escaped.join('|')})`, 'g');
}

function findAllChatMatches(text) {
    const matches = [];
    let m;

    CODE_REF_PATTERN.lastIndex = 0;
    while ((m = CODE_REF_PATTERN.exec(text)) !== null) {
        matches.push({
            index: m.index,
            end: CODE_REF_PATTERN.lastIndex,
            type: 'code',
            lineNumber: parseInt(m[1], 10),
            filename: m[2].trim(),
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

                let label;
                if (!lines) {
                    label = window.t('chat.chip_file_not_found', { filename: match.filename });
                } else if (match.lineNumber < 1 || match.lineNumber > lines.length) {
                    label = window.t('chat.chip_line_not_found', { filename: match.filename, line: match.lineNumber });
                } else {
                    label = `${match.filename} L${match.lineNumber}: ${lines[match.lineNumber - 1].trim()}`;
                }

                const chip = document.createElement('span');
                chip.className = 'chat-quote';
                chip.textContent = label;
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

        // Valida ANTES de enviar: se alguma citação referenciar um arquivo
        // desconhecido ou uma linha que não existe, bloqueia o envio,
        // limpa o campo e mostra um toast — em vez de mandar a mensagem.
        const invalidRefs = [];
        let match;
        CODE_REF_PATTERN.lastIndex = 0;
        while ((match = CODE_REF_PATTERN.exec(message)) !== null) {
            const lineNumber = parseInt(match[1], 10);
            const filename = match[2].trim();
            const lines = (window.getFileLinesForFilename && window.getFileLinesForFilename(filename)) || null;

            if (!lines) {
                invalidRefs.push(window.t('chat.invalid_ref_file_not_found', { filename }));
            } else if (lineNumber < 1 || lineNumber > lines.length) {
                invalidRefs.push(window.t('chat.invalid_ref_line_out_of_range', { filename, line: lineNumber, total: lines.length }));
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
