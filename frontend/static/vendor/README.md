# Bibliotecas de terceiros vendorizadas

Esses arquivos foram baixados uma única vez (via pacotes npm oficiais) e
commitados no repositório, no lugar de serem carregados de um CDN em tempo de
execução. Isso elimina uma dependência externa de runtime (se o CDN cair ou
mudar o conteúdo, o RoomsCode não é afetado) e evita ter que manter tags de
Subresource Integrity (SRI) manualmente.

| Pasta | Pacote npm de origem | Versão | Build usado |
|---|---|---|---|
| `socket.io/` | `socket.io-client` | 4.7.5 | `dist/socket.io.min.js` (build oficial UMD do pacote, sem modificação) |
| `highlight/` | `highlight.js` | 11.9.0 | `lib/index.js` (core + todas as linguagens) empacotado com `esbuild` em um único arquivo IIFE que expõe `window.hljs` — o pacote npm não publica mais um bundle de browser pronto, só o código-fonte CommonJS |
| `highlightjs-line-numbers/` | `highlightjs-line-numbers.js` | 2.9.0 | `dist/highlightjs-line-numbers.min.js` (build oficial UMD do pacote, sem modificação) |
| `diff-match-patch/` | `diff-match-patch` | 1.0.5 | `index.js` do pacote, com as 5 linhas finais de `module.exports` removidas (o restante do arquivo já é o código clássico do Google `diff-match-patch` em escopo global, idêntico em API ao antigo `diff_match_patch.js` do cdnjs) |

## Como atualizar uma versão no futuro

1. `npm pack <pacote>@<versão>` em uma máquina com acesso ao registry do npm.
2. Extrair o `.tgz` e pegar o arquivo de build indicado na tabela acima.
3. Para o `highlight.js`, recriar o bundle com:
   ```
   npx esbuild entry.js --bundle --minify --platform=browser --outfile=highlight.min.js
   ```
   onde `entry.js` é:
   ```js
   const hljs = require('highlight.js/lib/index.js');
   window.hljs = hljs;
   ```
4. Para o `diff-match-patch`, copiar `index.js` e apagar as linhas finais que
   começam com `module.exports`.
5. Substituir o arquivo correspondente aqui e atualizar a versão nesta tabela.

Licenças de cada pacote estão junto dos arquivos (`LICENSE` em cada subpasta).
