/**
 * Modal de instruções de instalação da extensão VS Code. Compartilhado
 * entre a home (botão no canto superior direito) e a sala (botão dentro
 * do painel de código, quando o Host não está compartilhando nada) — os
 * dois só precisam de um elemento com [data-open-download-modal] pra
 * abrir o mesmo modal.
 */
(function () {
    const modal = document.getElementById('download-modal');
    if (!modal) return;

    const backBtn = document.getElementById('download-modal-back-btn');
    const confirmLink = document.getElementById('download-modal-confirm-btn');

    function openModal() {
        modal.style.display = 'flex';
    }

    function closeModal() {
        modal.style.display = 'none';
    }

    document.querySelectorAll('[data-open-download-modal]').forEach((el) => {
        el.addEventListener('click', openModal);
    });

    if (backBtn) backBtn.addEventListener('click', closeModal);

    // O link de baixar já dispara o download por conta própria (href +
    // atributo `download`); só fechamos o modal em seguida.
    if (confirmLink) confirmLink.addEventListener('click', closeModal);

    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.style.display !== 'none') {
            closeModal();
        }
    });

    window.openDownloadModal = openModal;
    window.closeDownloadModal = closeModal;
})();
