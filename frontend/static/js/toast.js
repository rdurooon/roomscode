function ensureToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
        window.addEventListener('resize', positionToastContainer);
    }
    positionToastContainer();
    return container;
}

function positionToastContainer() {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Posição calculada a partir da altura real da topbar, pra nunca sobrepor os ícones.
    const topbar = document.querySelector('.topbar');
    const topOffset = topbar ? topbar.getBoundingClientRect().bottom + 12 : 16;
    container.style.top = `${topOffset}px`;
}

function showToast(message, type = 'error') {
    const container = ensureToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Força reflow antes de adicionar a classe de transição, senão o
    // navegador pode agrupar as duas mudanças e a animação não roda.
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    setTimeout(() => {
        toast.classList.remove('toast-visible');
        setTimeout(() => toast.remove(), 250);
    }, 4500);
}

window.showToast = showToast;
