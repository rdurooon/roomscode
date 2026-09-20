# RoomsCode

Plataforma para aulas e apresentações de programação ao vivo. Um **Host**
compartilha a tela e/ou o arquivo ativo do VS Code; **Espectadores**
acompanham em tempo real (com highlight de sintaxe, zoom/scroll
independentes) e conversam pelo chat, sem poder editar nada.

Este repositório é só o site (backend Flask + frontend). A extensão do VS
Code que o Host usa pra transmitir o código do editor mora num repositório
irmão, **roomscode-extension** — ver o README de lá pra instalar/rodar.

## Estrutura do projeto

```
roomscode/
├── backend/      # Flask + Flask-SocketIO (salas, chat, sync. de arquivo, sinalização WebRTC)
├── frontend/     # Páginas do Host e do Espectador (templates + JS/CSS)
└── tests/        # Testes de backend (Socket.IO real) e frontend (jsdom)
```

## 1. Rodando o backend

```bash
cd roomscode
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Na primeira execução, se ainda não existir um `.env` nesta pasta, o próprio
programa cria um com uma `SECRET_KEY` gerada automaticamente — não precisa
preparar nada antes (ver `backend/secrets_bootstrap.py` e `.env.example`).

O servidor sobe em `http://localhost:5000`:

- Página inicial (`/`): dois botões, **Host** e **Espectador**.
- Página do Host: `http://localhost:5000/anfitriao`
- Página do Espectador: `http://localhost:5000/espectador`

Ao entrar em qualquer uma das duas, um modal pede o nome (e, no caso do
Espectador, o código da sala) antes de liberar a interface.

### Testando o fluxo básico (sem a extensão)

1. Abra `/`, clique em **Host** — o modal pede seu nome e, ao confirmar,
   mostra o código de 6 caracteres da sala pra você repassar.
2. Abra `/` em outra aba (ou outro navegador), clique em **Espectador** —
   informe nome e o código da sala no modal.
3. No Host, clique no botão **Compartilhar tela** (centralizado sobre o
   painel de vídeo) — ele vira **Parar compartilhamento** e migra pro canto
   inferior esquerdo do painel enquanto a tela está sendo compartilhada.
4. O painel de código só é preenchido quando a extensão do VS Code
   (repositório **roomscode-extension**) estiver conectada à mesma sala,
   usando o código de extensão mostrado na tela do Host (botão fixo
   "Copiar código da extensão" — não precisa mais do código da sala nesse
   passo, o código da extensão já identifica a sala sozinho).

## Baixando a extensão pela home

A home (`/`) tem um botão **"Baixar extensão"** no canto superior direito
(abre um modal com instruções curtas de instalação antes de baixar),
servido direto pela rota `/baixar-extensao` (ver `backend/routes/downloads.py`) —
útil enquanto a extensão não está publicada na Marketplace (`vsce publish`).
O arquivo em si vive em `frontend/static/downloads/roomscode-extension.vsix`.

**Importante:** este repositório e o `roomscode-extension` são
independentes agora — atualizar a extensão lá **não** atualiza esse
arquivo aqui sozinho. Pra publicar uma versão nova pela home, depois de
gerar o `.vsix` no repositório da extensão (`npm run package`), copie o
arquivo gerado pra cá, sobrescrevendo o nome fixo:

```bash
cp ../roomscode-extension/roomscode-extension-X.Y.Z.vsix \
   frontend/static/downloads/roomscode-extension.vsix
```

O link na home não muda (nome de arquivo fixo, independente da versão) —
só o conteúdo é atualizado.

## 2. Rodando em produção (Docker)

```bash
cd roomscode
docker compose up -d --build
```

Não precisa criar `.env` nem nada antes — a `SECRET_KEY` é gerada sozinha
dentro de um volume Docker nomeado na primeira subida (ver comentários em
`docker-compose.yml` e `backend/secrets_bootstrap.py`). Pra atualizações
subsequentes num servidor já configurado, use `./deploy.sh` (ajuste
`APP_DIR` no topo do script pro caminho real do seu servidor primeiro).

## Ajustando o layout

Entre a tela do Host e o painel de código tem uma alça (arraste com o
mouse) pra redimensionar a proporção entre os dois — útil quando um dos
dois precisa de mais espaço. A barra de abas e o nome do arquivo ficam
fixos no topo do painel de código mesmo ao rolar um arquivo grande.

O painel de código também mostra guias de indentação (linhas verticais
finas, no estilo VS Code) atrás do código, pra facilitar visualizar blocos
aninhados em arquivos com muitos níveis de indentação.

A cor de destaque do site é sorteada a cada carregamento (ver seção sobre
o tema mais abaixo) e também tinge sutilmente o fundo da página, atrás dos
painéis — dando uma sensação de ambiente colorido sem depender de efeitos
nas próprias janelas.

## Citando código no chat

O comando é `!code(linha, arquivo)` — por exemplo `!code(23, main.py)`.
Duas formas de gerar isso, ambas funcionam junto com texto normal na mesma
mensagem:

1. **Digitando à mão** — digite `!` no chat e um menu de sugestão aparece
   acima do campo, mostrando os comandos disponíveis. Ao digitar a vírgula
   e começar o nome do arquivo, um segundo menu sugere as abas abertas no
   momento (filtrando pelo que você já digitou).
2. **Seleção de trecho no painel de código** — selecione um pedaço do
   código, um botão flutuante "Citar linha N no chat" aparece; ao clicar,
   o comando já sai completo (`!code(N, arquivo)`), com o arquivo
   preenchido automaticamente a partir da aba que você estava vendo.

Se a linha ou o arquivo citado não existir, o envio é bloqueado, o campo é
limpo, e um toast explica o motivo.

## Mencionando pessoas no chat

Duas formas, ambas com sugestão de nomes acima do campo enquanto digita:

1. **`!user(nome)`** — digite `!user(` e escolha um dos participantes
   sugeridos (funciona igual ao `!code`, incluindo Tab pra completar).
2. **`@nome`** — digite só `@` e a lista de participantes já aparece. Nomes
   com espaço (ex: "Ana Paula") são reconhecidos inteiros, não só a
   primeira palavra.

Quando alguém te menciona, seu nome aparece destacado com um fundo sólido
no chat — mais fácil de notar que só um texto colorido.

## Seguindo o Host

Do lado do Espectador, uma checkbox "Seguir o Host" aparece acima do painel
de código. Quando marcada, a aba e a linha exibidas trocam automaticamente
pra acompanhar onde o Host está navegando — inclusive pulando direto pra lá
assim que você marca a checkbox, sem esperar o próximo movimento do Host.
Se você trocar de aba manualmente enquanto o modo está ativo, ele desliga
sozinho (senão o próximo movimento do Host te puxaria de volta sem avisar).
A checkbox é estilizada: vazia (sem preenchimento) quando desmarcada, e
preenchida com a cor de destaque atual do site quando marcada.

## Copiando e baixando o arquivo atual

Ao lado do nome do arquivo, dois botões: um copia o conteúdo inteiro da aba
exibida pra área de transferência, o outro baixa o arquivo (mantendo nome e
extensão originais, ex: `main.py`). Disponível tanto pro Host quanto pro
Espectador.

## Liberando o código da sala pros Espectadores

Por padrão, só o Host vê o código de entrada da sala (com o botão de olho
pra revelar/ocultar). Ao lado desse botão, um ícone de cadeado permite ao
Host liberar esse código também pros Espectadores — quando liberado, o
código aparece na tela de todo mundo (sem botão de olho do lado deles,
sempre visível) e pode ser copiado com um clique, igual do lado do Host.

## Entrando e saindo da sala

Na tela de nome/código (que aparece ao clicar em Host ou Espectador na
home), um botão "Voltar" ao lado do botão principal permite desistir e
retornar à home sem precisar recarregar a página.

Clicar na marca "RoomsCode" (canto superior esquerdo) ou no ícone de porta
(canto superior direito), já dentro da sala, abre um popup de confirmação
(no mesmo estilo visual do modal de entrada, não o `confirm()` padrão do
navegador) antes de sair:

- **Host**: "Deseja sair da sala? Ao sair, a sala será desfeita!" — ao
  confirmar, a sala é encerrada pra todo mundo (mensagem "O host desfez a
  sala.").
- **Espectador**: "Deseja sair da sala? Para retornar, use o código
  novamente." — só ele sai, a sala continua.

O popup pode ser fechado com "Cancelar", clicando fora do card, ou com Esc.

Se o Host cair sem avisar (perda de conexão, F5, fechar a aba), a sala
**não** é encerrada na hora: ela entra em um estado de graça (60s por
padrão, configurável via `HOST_RECONNECT_GRACE_SECONDS`) enquanto o Host
tenta voltar. Os Espectadores veem um aviso fixo no topo da página com a
contagem regressiva ("O host perdeu a conexão. Se não voltar em Xs, a sala
será encerrada."), e continuam vendo o último código/tela normalmente. Se o
Host reconectar a tempo — automaticamente (o navegador tenta sozinho) ou
recarregando a página — a sala é retomada exatamente do ponto onde parou,
sem perder nada, e todos são avisados ("O host reconectou!"). Só se o prazo
esgotar sem ele voltar é que a sala é encerrada de vez, com a mensagem "O
host não retornou a tempo e a sala foi encerrada." e redirecionamento pra
home.

## Robustez de conexão

- **Reconexão do Host**: ver seção acima. A sala guarda um token de sessão
  do Host (`host_session_token`, nunca exposto a Espectadores) só pra isso
  — sem ele, ninguém mais consegue "assumir" uma sala órfã sabendo apenas o
  código (que é semi-público).
- **Extensão VS Code**: mostra uma notificação de progresso durante a
  conexão (com o tempo decorrido e o estágio atual — conectando ou
  autenticando — e um botão de cancelar), tenta WebSocket direto primeiro
  (evita o round-trip extra do handshake por polling do socket.io) e mede a
  latência real com o servidor a cada 15s, exibida no tooltip da barra de
  status (`conectado à sala ABC123 (42ms — ótima)`). Se a extensão cair
  sozinha (rede do computador do Host, não da sala), ela reconecta e
  reautentica automaticamente — o token continua válido, não precisa
  digitar de novo.
- **WebRTC (vídeo da tela)**: monitora o estado da conexão ICE em tempo
  real; se degradar (`disconnected`/`failed`) por instabilidade de rede,
  tenta um *ICE restart* automático (até 3 tentativas) antes de desistir e
  só então avisar o usuário — antes, uma rede instável simplesmente matava
  a chamada de vídeo em silêncio, sem tentar se recuperar.
- **Socket.IO (Host/Espectador no navegador)**: parâmetros de reconexão
  explícitos e detecção de queda ajustada (`ping_interval`/`ping_timeout`
  do backend) pra avisar de uma queda de verdade bem mais rápido que o
  default da lib, sem confundir jitter de rede pontual com desconexão.
  Espectadores também guardam sessão (código + nome) pra voltar sozinhos à
  sala depois de uma queda breve, sem precisar digitar tudo de novo.

## Limitações conhecidas (por design, por enquanto)

- **Vídeo em topologia mesh**: o Host conecta diretamente com cada
  Espectador via WebRTC. Funciona bem para poucos espectadores, mas não
  escala para turmas grandes — migrar para um SFU (ex: LiveKit) resolveria
  isso.
- **Só STUN público** (Google) configurado, sem servidor TURN — em redes
  com NAT/firewall restritivo (comum em instituições, ex: faixas `10.x.x.x`)
  a conexão de vídeo pode não fechar e a tela do Host fica preta pro
  Espectador, mesmo com áudio/chat/código funcionando normalmente (o ICE
  restart automático ajuda em instabilidade transitória, mas não resolve
  uma rede que bloqueia WebRTC por completo). Agora que o site já está
  atrás de um domínio HTTPS de verdade, adicionar um servidor TURN (ou
  TURN sobre TLS, `turns:`, pra redes ainda mais restritivas) é só
  acrescentar uma entrada em `RTC_CONFIG.iceServers`
  (`frontend/static/js/webrtc-client.js`) — decisão de infraestrutura
  adiada por enquanto.
- **Compartilhamento de arquivos limitado ao workspace atual**: o Host só
  compartilha o que estiver dentro da pasta/workspace aberta no VS Code —
  não existe (ainda) um jeito de ocultar seletivamente só alguns arquivos
  DENTRO do workspace.
- **Estado em memória**: as salas (e o estado de graça de reconexão) vivem
  na memória do processo Flask. Reiniciar o servidor encerra todas as
  salas ativas, mesmo as em estado de graça. Migrar para Redis quando for
  rodar com múltiplos workers.
- **Sem autenticação**: qualquer pessoa com o código da sala entra como
  Espectador. Suficiente por enquanto; considerar autenticação em fase
  futura.

## Próximos passos

Fases futuras planejadas: múltiplas abas visíveis simultaneamente,
bloqueio de arquivos específicos pelo Host, citação de linha de código no
chat, indicador de "linha atual" mais robusto, co-host, app desktop e modo
de comparação de código.
