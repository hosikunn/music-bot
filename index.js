require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { YouTube } = require('youtube-sr');

// --- yt-dlp本体のパス(Windowsローカルなら bin/yt-dlp.exe、クラウドなら bin/yt-dlp) ---
const YTDLP_PATH = path.join(
  __dirname,
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// --- YouTubeのCookieを準備する ---
// 環境変数 YOUTUBE_COOKIES_BASE64 があれば、それを cookies.txt として書き出す(クラウド用)
// 無ければ、ローカルに置かれている cookies.txt をそのまま使う
function prepareCookies() {
  if (process.env.YOUTUBE_COOKIES_BASE64) {
    try {
      const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf8');
      fs.writeFileSync(COOKIES_PATH, decoded, 'utf8');
      console.log('✅ 環境変数からCookieファイルを書き出しました。');
    } catch (err) {
      console.error('Cookie書き出しエラー:', err);
    }
  } else if (fs.existsSync(COOKIES_PATH)) {
    console.log('✅ ローカルのcookies.txtを使用します。');
  } else {
    console.log('⚠️ Cookieが設定されていません(再生に失敗する場合があります)。');
  }
}
prepareCookies();

function hasCookies() {
  return fs.existsSync(COOKIES_PATH);
}

// yt-dlpで動画の情報(タイトル・URL)を取得する
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-single-json', '--no-warnings', '--no-playlist'];
    if (hasCookies()) args.push('--cookies', COOKIES_PATH);
    args.push(url);

    execFile(YTDLP_PATH, args, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const info = JSON.parse(stdout);
        resolve({ title: info.title, url: info.webpage_url || url });
      } catch (err) {
        reject(err);
      }
    });
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// サーバー(guild)ごとの再生状態を保持するMap
// { connection, player, queue: [{title, url, requestedBy}], playing, textChannel, currentSong, currentProcess }
const guildQueues = new Map();

function getQueue(guildId) {
  if (!guildQueues.has(guildId)) {
    guildQueues.set(guildId, {
      connection: null,
      player: null,
      queue: [],
      playing: false,
      textChannel: null,
      currentSong: null,
      currentProcess: null,
    });
  }
  return guildQueues.get(guildId);
}

// 曲を1つ再生する(再生完了後は自動的に次の曲へ)
async function playNext(guildId) {
  const state = getQueue(guildId);

  if (state.queue.length === 0) {
    state.playing = false;
    state.currentSong = null;
    // キューが空になったら少し待ってから自動退出(すぐ次のplayが来る可能性があるため)
    setTimeout(() => {
      const s = getQueue(guildId);
      if (!s.playing && s.queue.length === 0 && s.connection) {
        s.connection.destroy();
        s.connection = null;
      }
    }, 30_000);
    return;
  }

  const song = state.queue.shift();
  state.playing = true;
  state.currentSong = song;

  try {
    const args = ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--quiet', '--no-warnings'];
    if (hasCookies()) args.push('--cookies', COOKIES_PATH);
    args.push(song.url);

    const ytdlpProcess = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.currentProcess = ytdlpProcess;

    let stderrOutput = '';
    ytdlpProcess.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });
    ytdlpProcess.on('error', (err) => {
      console.error('yt-dlp起動エラー:', err);
    });
    ytdlpProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`yt-dlpが異常終了しました(code: ${code}): ${stderrOutput}`);
      }
    });

    const resource = createAudioResource(ytdlpProcess.stdout, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });
    resource.volume?.setVolume(0.5);

    state.player.play(resource);

    if (state.textChannel) {
      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setTitle('🎵 再生中')
        .setDescription(`[${song.title}](${song.url})`)
        .setFooter({ text: `リクエスト: ${song.requestedBy}` });
      state.textChannel.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (err) {
    console.error('再生エラー:', err);
    if (state.textChannel) {
      state.textChannel.send(`⚠️ 「${song.title}」の再生に失敗しました。次の曲へ進みます。`).catch(() => {});
    }
    playNext(guildId);
  }
}

client.once('ready', () => {
  console.log(`✅ ログインしました: ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;
  const state = getQueue(guild.id);

  // play以外は再生中のコネクションが必要
  if (commandName !== 'play' && !state.connection) {
    return interaction.reply({ content: '❌ 現在ボイスチャンネルに接続していません。', ephemeral: true });
  }

  switch (commandName) {
    case 'play': {
      const keyword = interaction.options.getString('keyword');
      const voiceChannel = member.voice.channel;

      if (!voiceChannel) {
        return interaction.reply({ content: '❌ 先にボイスチャンネルに参加してください。', ephemeral: true });
      }

      await interaction.deferReply();

      try {
        let songInfo;
        const isUrl = /^https?:\/\//i.test(keyword);

        if (isUrl) {
          songInfo = await getVideoInfo(keyword);
        } else {
          const results = await YouTube.search(keyword, { limit: 1, type: 'video' });
          if (!results || results.length === 0) {
            return interaction.editReply('❌ 該当する曲が見つかりませんでした。');
          }
          songInfo = { title: results[0].title, url: results[0].url };
        }

        const song = {
          title: songInfo.title,
          url: songInfo.url,
          requestedBy: interaction.user.tag,
        };

        state.textChannel = interaction.channel;

        // ボイスチャンネルへの接続がまだなければ接続する
        if (!state.connection) {
          const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
          });

          try {
            await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
          } catch (err) {
            console.error('接続エラー詳細:', err);
            connection.destroy();
            return interaction.editReply('❌ ボイスチャンネルへの接続に失敗しました。');
          }

          const player = createAudioPlayer();
          connection.subscribe(player);

          player.on(AudioPlayerStatus.Idle, () => {
            playNext(guild.id);
          });
          player.on('error', (error) => {
            console.error('プレイヤーエラー:', error);
            playNext(guild.id);
          });

          state.connection = connection;
          state.player = player;
        }

        state.queue.push(song);

        if (!state.playing) {
          await interaction.editReply(`▶️ 再生を開始します: **${song.title}**`);
          playNext(guild.id);
        } else {
          await interaction.editReply(`✅ キューに追加しました: **${song.title}** (現在 ${state.queue.length} 曲待ち)`);
        }
      } catch (err) {
        console.error('playコマンドエラー:', err);
        await interaction.editReply('❌ 曲の取得中にエラーが発生しました。URLや曲名を確認してください。');
      }
      break;
    }

    case 'skip': {
      if (!state.playing) {
        return interaction.reply({ content: '⚠️ 現在再生中の曲はありません。', ephemeral: true });
      }
      state.player.stop(); // Idleイベントが発火し、自動的に次の曲が再生される
      await interaction.reply('⏭️ 曲をスキップしました。');
      break;
    }

    case 'stop': {
      state.queue = [];
      state.playing = false;
      state.currentSong = null;
      if (state.currentProcess) {
        state.currentProcess.kill();
        state.currentProcess = null;
      }
      if (state.player) state.player.stop();
      if (state.connection) {
        state.connection.destroy();
        state.connection = null;
      }
      await interaction.reply('⏹️ 再生を停止し、ボイスチャンネルから退出しました。');
      break;
    }

    case 'pause': {
      if (!state.playing) {
        return interaction.reply({ content: '⚠️ 現在再生中の曲はありません。', ephemeral: true });
      }
      state.player.pause();
      await interaction.reply('⏸️ 一時停止しました。');
      break;
    }

    case 'resume': {
      state.player.unpause();
      await interaction.reply('▶️ 再生を再開しました。');
      break;
    }

    case 'queue': {
      if (state.queue.length === 0 && !state.currentSong) {
        return interaction.reply('📭 キューは空です。');
      }
      const lines = state.queue.map((s, i) => `${i + 1}. ${s.title} (${s.requestedBy})`);
      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setTitle('📜 再生キュー')
        .setDescription(
          (state.currentSong ? `**再生中:** ${state.currentSong.title}\n\n` : '') +
          (lines.length > 0 ? lines.join('\n') : '待機中の曲はありません。')
        );
      await interaction.reply({ embeds: [embed] });
      break;
    }

    case 'nowplaying': {
      if (!state.currentSong) {
        return interaction.reply('📭 現在再生中の曲はありません。');
      }
      await interaction.reply(`🎵 現在再生中: **${state.currentSong.title}** (リクエスト: ${state.currentSong.requestedBy})`);
      break;
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
