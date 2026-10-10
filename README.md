# RoomsCode

Plataforma web para aulas e apresentações de programação ao vivo. O **Host** compartilha a tela e o código do VS Code; os **Espectadores** acompanham pelo navegador, sem instalar nada, e conversam pelo chat. A interface está em português, inglês e espanhol.

- Site: [roomscode.com](https://roomscode.com)
- Extensão do VS Code (usada pelo Host): [Marketplace](https://marketplace.visualstudio.com/items?itemName=rdurooon.roomscode-extension) · [repositório](https://github.com/rdurooon/roomscode-extension)

## Funcionalidades

- **Tela do Host** transmitida ao vivo, direto pelo navegador.
- **Código em tempo real**, vindo da extensão: todas as abas abertas, com destaque de sintaxe, zoom e rolagem independentes. O Espectador pode copiar ou baixar o arquivo e ativar **Seguir o Host** para acompanhar a aba e a linha dele.
- **Chat** com citação de código (`!code(23, main.py)`) e menções (`@nome` ou `!user(nome)`). O Host pode silenciar o chat de um Espectador ou removê-lo da sala.
- **Sala por código** de 6 caracteres e link de convite.
- **Reconexão do Host**: se ele cair, a sala espera 60 s (configurável) antes de ser encerrada.

## Como funciona

Três canais independentes, todos passando pelo backend Flask, que cuida das salas:

- **Vídeo:** WebRTC direto do Host para cada Espectador. O Flask só faz a sinalização; o vídeo não passa por ele.
- **Código:** a extensão envia o arquivo ativo e, depois, só as alterações (Socket.IO), que o servidor repassa à sala.
- **Chat:** mensagens por Socket.IO, com sanitização e limite de envio.

Stack: Flask + Flask-SocketIO (eventlet), JavaScript e CSS puros, highlight.js e diff-match-patch.

## Rodando localmente

```bash
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

O servidor sobe em `http://localhost:5000`: o Host entra em `/anfitriao` e o Espectador em `/espectador`. Não precisa criar `.env`: na primeira execução o programa gera um com a `SECRET_KEY`.

Para testar sem a extensão, abra o Host e o Espectador em duas abas (o Espectador usa o código de 6 caracteres que o Host mostra) e clique em **Compartilhar tela**. O painel de código só é preenchido com a extensão conectada, usando o **código da extensão** mostrado na tela do Host.

## Produção (Docker)

```bash
docker compose up -d --build
```

Nada precisa ser criado antes: a `SECRET_KEY` é gerada num volume do Docker na primeira subida. Em um servidor já configurado, atualize com `./deploy.sh` (ajuste o `APP_DIR` no topo do script).

Variáveis opcionais, em um `.env` ao lado do `docker-compose.yml` (modelo em `.env.example`):

| Variável | Para quê | Padrão |
|---|---|---|
| `FLASK_ENV` | `development` libera CORS aberto para uso local | `production` |
| `ALLOWED_ORIGIN` | Domínio permitido pelo Socket.IO (CORS) | vazio (só mesma origem) |
| `TRUSTED_PROXY_COUNT` | Proxies reversos confiáveis na frente do app | `1` |
| `HOST_RECONNECT_GRACE_SECONDS` | Tempo que a sala espera o Host voltar | `60` |

Os demais limites (tamanho de arquivo, proteção contra abuso, ping do Socket.IO) estão em `backend/config.py`.

## Estrutura do projeto

```
roomscode/
├── backend/    # Flask + Socket.IO: salas, eventos (vídeo, arquivos, chat, presença) e traduções
├── frontend/   # Templates e JS/CSS das páginas do Host e do Espectador
├── Dockerfile · docker-compose.yml · deploy.sh
└── run.py · wsgi.py
```

## Limitações conhecidas

- **Vídeo:** cada Espectador recebe uma conexão própria do Host, então o uso de CPU e de upload do computador dele cresce com o número de espectadores. Em redes restritivas (comum em instituições) a conexão pode não fechar. Nesse caso o Espectador vê "Não foi possível receber a tela do host", com o botão "Tentar novamente", e o código e o chat continuam funcionando. Resolver isso exigiria um servidor TURN/SFU com IP público.
- **Workspace:** só é compartilhado o que está na pasta aberta no VS Code. Ainda não dá para ocultar arquivos dentro dela.
- **Salas em memória:** reiniciar o servidor encerra todas as salas. Para rodar com vários processos seria preciso migrar para Redis.
- **Sem autenticação:** quem tiver o código da sala entra como Espectador.