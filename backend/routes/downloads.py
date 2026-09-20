import os

from flask import Blueprint, current_app, send_from_directory

downloads_bp = Blueprint("downloads", __name__)

# Nome de arquivo fixo, independente da versão embutida no nome original do
# .vsix (ex: roomscode-extension-0.0.2.vsix) — assim a URL /baixar-extensao
# nunca muda quando a extensão for atualizada, só o conteúdo do arquivo.
#
# Esse arquivo é copiado manualmente pra cá a partir do repositório
# roomscode-extension (repositório separado — ver README.md na raiz deste
# projeto) toda vez que uma nova versão for gerada com `vsce package`.
# Não há automação entre os dois repositórios ainda; é um passo manual
# consciente, documentado no README.
EXTENSION_VSIX_FILENAME = "roomscode-extension.vsix"


@downloads_bp.route("/baixar-extensao")
def download_extension():
    downloads_dir = os.path.join(current_app.static_folder, "downloads")
    return send_from_directory(
        downloads_dir,
        EXTENSION_VSIX_FILENAME,
        as_attachment=True,
        download_name=EXTENSION_VSIX_FILENAME,
    )
