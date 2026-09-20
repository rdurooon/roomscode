/**
 * Copia texto pra área de transferência, com fallback pro método antigo
 * (execCommand) quando navigator.clipboard não está disponível — ex: em
 * contexto HTTP não seguro (fora de localhost), onde a API moderna de
 * clipboard não existe.
 */
async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            // segue pro fallback abaixo
        }
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        return true;
    } catch (err) {
        return false;
    }
}

window.copyTextToClipboard = copyTextToClipboard;
