# Discord 音楽再生Bot

discord.js v14 + @discordjs/voice + play-dl を使った、YouTube音楽再生Botです。

## 機能

- `/play <曲名 または URL>` — 曲を再生(再生中なら自動でキューに追加)
- `/skip` — 現在の曲をスキップ
- `/stop` — 再生停止・キュークリア・ボイスチャンネル退出
- `/pause` / `/resume` — 一時停止・再開
- `/queue` — 再生キュー表示
- `/nowplaying` — 現在再生中の曲を表示

## セットアップ手順

### 1. Discord Botの作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセスしてログイン
2. 「New Application」から新しいアプリケーションを作成
3. 左メニューの「Bot」→「Add Bot」でBotを作成
4. 「Reset Token」でトークンを取得(これが `DISCORD_TOKEN` になります。他人に見せないこと)
5. 「Privileged Gateway Intents」で **SERVER MEMBERS INTENT** は不要ですが、特に制限なければそのままでOK
6. 左メニューの「OAuth2」→「General」で **Client ID** を確認(これが `CLIENT_ID` になります)
7. 「OAuth2」→「URL Generator」で
   - SCOPES: `bot`, `applications.commands`
   - BOT PERMISSIONS: `Connect`, `Speak`, `Send Messages`, `Embed Links`, `Use Slash Commands`
   - 生成されたURLをブラウザで開き、Botを自分のサーバーに招待

### 2. 環境構築

```bash
# 依存パッケージのインストール(Node.js 18以上を推奨)
npm install
```

`.env.example` を `.env` にコピーして、取得したトークンなどを記入してください。

```bash
cp .env.example .env
```

```
DISCORD_TOKEN=実際のBotトークン
CLIENT_ID=実際のClient ID
GUILD_ID=(開発中は自分のテストサーバーIDを入れると即反映されて便利です。空欄でもOK)
```

### 3. スラッシュコマンドの登録

```bash
npm run deploy
```

### 4. Bot起動

```bash
npm start
```

正常に起動すると `✅ ログインしました: BotName#0000` と表示されます。

## 使い方

Discordサーバー内で、ボイスチャンネルに参加した状態で以下のように使います。

```
/play keyword: 好きな曲名 または YouTubeのURL
/skip
/queue
/stop
```

## 注意点・補足

- **ffmpeg**: `ffmpeg-static` により自動でバイナリが用意されるので、別途インストール不要です。
- **著作権**: 音楽の再生は、各配信元(YouTube等)の利用規約を遵守してご利用ください。
- **常時稼働させたい場合**: このスクリプトはPCやローカル環境で動かすと、PCを閉じると停止します。24時間稼働させたい場合は、VPSやRailway、Renderなどのホスティングサービスにデプロイしてください。
- **エラーが出る場合**: `play-dl` はYouTube側の仕様変更の影響を受けやすいライブラリです。再生できない場合は `npm update play-dl` を試すか、`distube` など別ライブラリへの切り替えもご検討ください。

## ディレクトリ構成

```
music-bot/
├── index.js            # Bot本体
├── deploy-commands.js  # スラッシュコマンド登録スクリプト
├── package.json
├── .env.example
└── README.md
```
