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

---

## Dashboard Web (Estatísticas, Contas e Configurações)

O bot inclui uma dashboard web somente leitura servida em `GET /` (mantendo `GET /health` para healthcheck), persistindo o histórico em SQLite (`/app/data/panchlive.sqlite` via volume Docker `bot-data`).

> **Importante:** o histórico começa a ser coletado a partir do momento em que esta versão entra no ar.

### Variáveis de ambiente da Dashboard

Adicione ao `.env` da VPS conforme necessário:

```env
# Porta publicada em 127.0.0.1 no host da VPS (dentro do container o bot sempre escuta na 3000)
DASHBOARD_HOST_PORT=3000

# Em produção (Docker), HTTPS é obrigatório para login e acesso à API (fail-closed)
DASHBOARD_REQUIRE_HTTPS=true
TRUST_PROXY=true

# Opcional: URL pública HTTPS usada nos metadados Open Graph (preview no Discord/WhatsApp)
# DASHBOARD_PUBLIC_URL=https://dashboard.seudominio.com

# Bootstrap seguro do primeiro administrador (criado apenas quando não existe nenhuma conta)
DASHBOARD_ADMIN_USERNAME=admin
DASHBOARD_ADMIN_PASSWORD=troque_por_uma_senha_forte

# Alternativa ao bootstrap: token para liberar a tela de setup inicial via HTTPS
# DASHBOARD_SETUP_TOKEN=gere_um_token_aleatorio_longo
```

> Depois que a primeira conta administradora for criada no banco, você pode remover `DASHBOARD_ADMIN_PASSWORD` do `.env` (o bot nunca sobrescreve contas já criadas). Novos usuários são adicionados na aba **Configurações** (criação direta ou código de convite de uso único).

### Configurar HTTPS no proxy reverso da VPS

No `docker-compose.yml`, a dashboard fica restrita a `127.0.0.1:3000` para impedir acesso direto sem criptografia. Aponte seu domínio HTTPS no proxy global da VPS para `127.0.0.1:3000`, **sobrescrevendo** `X-Forwarded-Proto`:

#### Exemplo com Caddy
```caddy
dashboard.seudominio.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto https
        header_up X-Forwarded-Host {host}
    }
}
```

#### Exemplo com Nginx (com certificado TLS / Certbot)
```nginx
server {
    listen 443 ssl http2;
    server_name dashboard.seudominio.com;

    ssl_certificate /etc/letsencrypt/live/dashboard.seudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dashboard.seudominio.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```
