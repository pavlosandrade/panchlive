# PanchLive

Bot privado de música para Discord feito em **TypeScript (`discord.js` v14)** com servidor de áudio **Lavalink v4** e plugin `youtube-source`.

## Funcionalidades (V1)

- `/play <musica>`: aceita o **nome da música** (busca no YouTube) ou um **link direto** do YouTube.
- `/skip`: pula para a próxima música da fila.
- `/pause` e `/resume`: pausa e retoma a reprodução.
- `/stop`: para a música, limpa a fila e desconecta o bot da call.
- `/queue`: mostra a música atual e as próximas da fila.
- **Mensagem "Tocando agora" com botões**: controles `⏯️ Pausar/Retomar`, `⏭️ Pular` e `⏹️ Parar` direto no chat (os botões da música anterior são desativados automaticamente quando começa outra).
- **Saída automática**: o bot sai da call após 5 minutos (`IDLE_TIMEOUT_MIN=5`) quando a fila termina ou quando a call fica vazia.

---

## 1. Criar o Bot no Discord Developer Portal

1. Acesse [discord.com/developers/applications](https://discord.com/developers/applications) e clique em **New Application**.
2. Dê um nome (ex: `panchlive`) e copie o **Application ID** (esse é o `DISCORD_CLIENT_ID`).
3. No menu lateral, vá em **Bot**:
   - Clique em **Reset Token** e copie o token gerado (esse é o `DISCORD_TOKEN`).
   - *(Guarde no `.env`, nunca compartilhe nem faça commit desse token).*
4. No menu lateral, vá em **OAuth2 -> URL Generator**:
   - Em **Scopes**, marque `bot` e `applications.commands`.
   - Em **Bot Permissions**, marque:
     - `View Channels`
     - `Send Messages`
     - `Embed Links`
     - `Connect`
     - `Speak`
   - Copie a **Generated URL** no final da página, abra no navegador e adicione o bot ao seu servidor.
5. No Discord, ative o **Modo Desenvolvedor** (*Configurações de Usuário -> Avançado -> Modo desenvolvedor*), clique com o botão direito no ícone do seu servidor e clique em **Copiar ID do servidor** (esse é o `DISCORD_GUILD_ID`).

---

## 2. Configurar variáveis de ambiente

Copie o arquivo de exemplo e preencha os 3 campos do Discord:

```bash
cp .env.example .env
```

Edite o `.env`:

```env
DISCORD_TOKEN=seu_token_aqui
DISCORD_CLIENT_ID=id_da_aplicacao_aqui
DISCORD_GUILD_ID=id_do_seu_servidor_aqui

LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=panchlive-lavalink-secret

IDLE_TIMEOUT_MIN=5
```

---

## 3. Registrar os comandos no servidor

Com o `.env` preenchido, rode uma vez para registrar os comandos `/play`, `/skip`, `/pause`, `/resume`, `/stop` e `/queue` no seu servidor (aparecem na hora):

```bash
npm install
npm run deploy-commands
```

---

## 4. Rodar o bot

### Opção A: Tudo via Docker Compose (recomendado)

Sobe o Lavalink e o bot em segundo plano:

```bash
docker compose up -d --build
```

Para ver os logs:

```bash
docker compose logs -f
```

### Opção B: Lavalink no Docker + Bot em modo desenvolvimento

Útil se você estiver editando o código TypeScript:

```bash
docker compose up -d lavalink
npm run dev
```

---

## Manutenção: se o YouTube mudar algo e parar de tocar

Quando o YouTube altera suas proteções, a equipe do Lavalink lança uma atualização do plugin `youtube-source`:

1. Veja a versão mais recente em [github.com/lavalink-devs/youtube-source/releases](https://github.com/lavalink-devs/youtube-source/releases).
2. Atualize a linha `dependency: "dev.lavalink.youtube:youtube-plugin:X.Y.Z"` em `lavalink/application.yml`.
3. Reinicie o Lavalink:
   ```bash
   docker compose restart lavalink
   ```
