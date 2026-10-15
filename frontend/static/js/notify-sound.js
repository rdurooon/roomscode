// Aviso sonoro discreto de menção no chat: dois toques curtos e suaves gerados pelo próprio navegador
// (Web Audio), sem arquivo de áudio. Quem toca é só a pessoa mencionada (o servidor manda "chat_mention"
// apenas para ela; ver backend/events/chat.py e chat-client.js).
(function () {
    const NOTES = [
        { freq: 880, start: 0, length: 0.16 },
        { freq: 1175, start: 0.13, length: 0.26 },
    ];
    const VOLUME = 0.07; // baixo de propósito: é um aviso, não um alarme
    const MIN_GAP_MS = 800; // várias menções seguidas não viram uma sequência de apitos

    let ctx = null;
    let lastPlayedAt = 0;

    function getContext() {
        if (ctx) return ctx;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        try {
            ctx = new AudioCtx();
        } catch (e) {
            ctx = null;
        }
        return ctx;
    }

    // Navegadores só liberam áudio depois de uma interação com a página (entrar na sala já conta). Criamos e
    // "acordamos" o contexto no primeiro clique/tecla para ele já estar pronto quando a menção chegar.
    function unlock() {
        const c = getContext();
        if (c && c.state === 'suspended' && c.resume) {
            c.resume().catch(() => {});
        }
    }
    ['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => {
        document.addEventListener(eventName, unlock, { passive: true });
    });

    window.playMentionSound = function () {
        const now = Date.now();
        if (now - lastPlayedAt < MIN_GAP_MS) return false;

        const c = getContext();
        if (!c) return false;
        if (c.state === 'suspended' && c.resume) c.resume().catch(() => {});

        lastPlayedAt = now;
        try {
            const t0 = c.currentTime + 0.02;
            NOTES.forEach((note) => {
                const osc = c.createOscillator();
                const gain = c.createGain();
                osc.type = 'sine';
                osc.frequency.value = note.freq;

                const begin = t0 + note.start;
                gain.gain.setValueAtTime(0.0001, begin);
                gain.gain.exponentialRampToValueAtTime(VOLUME, begin + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, begin + note.length);

                osc.connect(gain);
                gain.connect(c.destination);
                osc.start(begin);
                osc.stop(begin + note.length + 0.05);
            });
        } catch (e) {
            return false;
        }
        return true;
    };
})();
