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

// YouTube側のブロック回避のため、複数のクライアントを順番に試す
// (どれか1つがうまくいけばそれを使う。日によって効くものが変わることがあるため)
const CLIENT_COMBOS = ['tv,ios', 'android,web,tv', 'web_safari,web', 'mweb,web', 'web'];

function execYtdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, args, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

// 動画の情報(タイトル・URL)を取得しつつ、有効なクライアントの組み合わせも特定する
async function getVideoInfo(url) {
  let lastError = null;
  for (const combo of CLIENT_COMBOS) {
    const args = ['--dump-single-json', '--no-warnings', '--no-playlist', '--extractor-args', `youtube:player_client=${combo}`];
    if (hasCookies()) args.push('--cookies', COOKIES_PATH);
    args.push(url);
    try {
      const stdout = await execYtdlp(args);
      const info = JSON.parse(stdout);
      return { title: info.title, url: info.webpage_url || url, playerClient: combo };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('全てのクライアントで取得に失敗しました');
}

// (曲名検索など、すでにURLとタイトルは分かっている場合に)有効なクライアントだけを特定する
async function findWorkingClient(url) {
  for (const combo of CLIENT_COMBOS) {
    const args = ['-f', 'bestaudio/best', '--simulate', '--quiet', '--no-warnings', '--extractor-args', `youtube:player_client=${combo}`];
    if (hasCookies()) args.push('--cookies', COOKIES_PATH);
    args.push(url);
    try {
      await execYtdlp(args);
      return combo;
    } catch (err) {
      // このクライアントでは失敗、次を試す
    }
  }
  return null;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// サーバー(guild)ごとの再生状態を保持するMap
const guildQueues = new Map();

function getQueue(guildId) {
  if (!guildQueues.has(guildId)) {
    guildQueues.set(guildId, {
      connection: null,
      player: null,
      queue: [],
      history: [],
      playing: false,
      textChannel: null,
      currentSong: null,
      currentProcess: null,
      currentResource: null,
      volume: 0.5,
      loopMode: 'off',
      skipRequested: false,
    });
  }
  return guildQueues.get(guildId);
}

function onSongFinished(guildId) {
  const state = getQueue(guildId);
  const forceAdvance = state.skipRequested;
  state.skipRequested = false;

  if (state.currentSong) {
    if (!forceAdvance && state.loopMode === 'track') {
      state.queue.unshift(state.currentSong);
    } else {
      state.history.push(state.currentSong);
      if (state.history.length > 20) state.history.shift();
      if (state.loopMode === 'queue') {
        state.queue.push(state.currentSong);
      }
    }
  }
  playNext(guildId);
}

async function playNext(guildId) {
  const state = getQueue(guildId);

  if (state.queue.length === 0) {
    state.playing = false;
    state.currentSong = null;
    setTimeout(() => {
      const s = getQueue(guildId);
      if (!s.playing && s.queue.length === 0 && s.connection) {
        s.connection.destroy();
        s.connection = null;
      }
    }, 30_000);
    return;
  }

  // 前の曲のyt-dlpプロセスが残っていれば、ここで確実に終了させる
  if (state.currentProcess) {
    state.currentProcess.kill('SIGTERM');
    state.currentProcess = null;
  }

  const song = state.queue.shift();
  state.playing = true;
  state.currentSong = song;

  try {
    const clientCombo = song.playerClient || CLIENT_COMBOS[0];
    const args = ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--quiet', '--no-warnings', '--extractor-args', `youtube:player_client=${clientCombo}`];
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
    ytdlpProcess.on('close', (code, signal) => {
      // スキップ等で意図的に終了させた場合(SIGTERM)は正常な後始末なのでログしない
      if (signal === 'SIGTERM') return;
      if (code !== 0 && code !== null) {
        console.error(`yt-dlpが異常終了しました(code: ${code}): ${stderrOutput}`);
      }
    });

    const resource = createAudioResource(ytdlpProcess.stdout, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });
    resource.volume?.setVolume(state.volume);
    state.currentResource = resource;

    state.player.play(resource);

    if (state.textChannel) {
      const loopLabel = state.loopMode === 'track' ? ' 🔂' : state.loopMode === 'queue' ? ' 🔁' : '';
      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setTitle(`🎵 再生中${loopLabel}`)
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

// ==================== お遊び機能 ====================

const OMIKUJI_RESULTS = [
  { label: '大吉', weight: 8,  comments: ['最高の1日になりそう!', '何をやってもうまくいく予感。', '思い切って挑戦してみて。'] },
  { label: '中吉', weight: 15, comments: ['良いことがありそうです。', '穏やかな1日になりそう。', 'ちょっとした幸運に恵まれるかも。'] },
  { label: '小吉', weight: 20, comments: ['まずまずの運勢です。', '無理せずマイペースに。', '小さな喜びを見つけられそう。'] },
  { label: '吉',   weight: 25, comments: ['平穏な1日を過ごせそう。', '普段通りが一番です。', '油断せず過ごしましょう。'] },
  { label: '末吉',  weight: 18, comments: ['これから運気が上向きに。', '焦らずじっくりいきましょう。', '後半にツキが回ってきそう。'] },
  { label: '凶',   weight: 10, comments: ['慎重に行動しましょう。', '無理は禁物です。', '今日は静かに過ごすのが吉。'] },
  { label: '大凶',  weight: 4,  comments: ['今日は思い切って休むのも手。', '油断大敵、慎重に。', '明日はきっと良くなります。'] },
];

function drawOmikuji() {
  const totalWeight = OMIKUJI_RESULTS.reduce((sum, r) => sum + r.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const result of OMIKUJI_RESULTS) {
    rand -= result.weight;
    if (rand <= 0) {
      const comment = result.comments[Math.floor(Math.random() * result.comments.length)];
      return { label: result.label, comment };
    }
  }
  return { label: '吉', comment: '穏やかな1日を。' };
}

const REACTION_RULES = [
  {
    trigger: /(おはよう|おは)/,
    replies: ['おはようございます!今日も良い1日を☀️', 'おはよう〜。しっかり寝れた?'],
  },
  {
    trigger: /(こんにちは|こんちは)/,
    replies: ['こんにちは!', 'やっほー、こんにちは😊'],
  },
  {
    trigger: /(こんばんは|こんばんわ)/,
    replies: ['こんばんは!今日もお疲れさまでした。', 'こんばんは〜、夜更かしはほどほどにね🌙'],
  },
  {
    trigger: /(疲れた|つかれた)/,
    replies: ['お疲れさまです…!ゆっくり休んでくださいね。', 'よく頑張りました。無理しないでね。'],
  },
  {
    trigger: /(眠い|ねむい)/,
    replies: ['眠い時は無理せず休むのが一番です💤', 'あくびが出そう…早めに寝るのもアリかも。'],
  },
  {
    trigger: /(ありがとう|thx|thanks)/i,
    replies: ['どういたしまして!', 'いえいえ、こちらこそ〜'],
  },
];

const REACTION_COOLDOWN_MS = 15_000;
const lastReactionTime = new Map();

// ==================== ここまで ====================

client.once('ready', () => {
  console.log(`✅ ログインしました: ${client.user.tag}`);
});

client.on('messageCreate', (message) => {
  if (message.author.bot) return;

  const now = Date.now();
  const lastTime = lastReactionTime.get(message.channelId) || 0;
  if (now - lastTime < REACTION_COOLDOWN_MS) return;

  for (const rule of REACTION_RULES) {
    if (rule.trigger.test(message.content)) {
      const reply = rule.replies[Math.floor(Math.random() * rule.replies.length)];
      message.channel.send(reply).catch(() => {});
      lastReactionTime.set(message.channelId, now);
      break;
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;

  if (commandName === 'omikuji') {
    const result = drawOmikuji();
    const embed = new EmbedBuilder()
      .setColor(0xffb703)
      .setTitle('🎋 今日のおみくじ')
      .setDescription(`**${result.label}**\n\n${result.comment}`)
      .setFooter({ text: `${interaction.user.username} さんの運勢` });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  const state = getQueue(guild.id);

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
          const workingClient = await findWorkingClient(results[0].url);
          if (!workingClient) {
            return interaction.editReply('❌ 現在YouTube側の制限により再生できません。少し時間をおいて再度試してください。');
          }
          songInfo = { title: results[0].title, url: results[0].url, playerClient: workingClient };
        }

        const song = {
          title: songInfo.title,
          url: songInfo.url,
          playerClient: songInfo.playerClient,
          requestedBy: interaction.user.tag,
        };

        state.textChannel = interaction.channel;

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
            onSongFinished(guild.id);
          });
          player.on('error', (error) => {
            console.error('プレイヤーエラー:', error);
            onSongFinished(guild.id);
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
        await interaction.editReply('❌ 現在YouTube側の制限により取得できませんでした。少し時間をおくか、別の曲・URLで試してください。');
      }
      break;
    }

    case 'skip': {
      if (!state.playing) {
        return interaction.reply({ content: '⚠️ 現在再生中の曲はありません。', ephemeral: true });
      }
      state.skipRequested = true;
      if (state.currentProcess) {
        state.currentProcess.kill('SIGTERM');
        state.currentProcess = null;
      }
      state.player.stop();
      await interaction.reply('⏭️ 曲をスキップしました。');
      break;
    }

    case 'stop': {
      state.queue = [];
      state.history = [];
      state.playing = false;
      state.currentSong = null;
      state.loopMode = 'off';
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
      const loopLabel = state.loopMode === 'track' ? '🔂 1曲ループ中' : state.loopMode === 'queue' ? '🔁 キューループ中' : null;
      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setTitle('📜 再生キュー')
        .setDescription(
          (loopLabel ? `${loopLabel}\n\n` : '') +
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

    case 'loop': {
      const mode = interaction.options.getString('mode');
      state.loopMode = mode;
      const label = mode === 'track' ? '🔂 1曲ループ' : mode === 'queue' ? '🔁 キュー全体ループ' : '⏹️ ループ解除';
      await interaction.reply(`${label} に設定しました。`);
      break;
    }

    case 'volume': {
      const percent = interaction.options.getInteger('level');
      state.volume = percent / 100;
      if (state.currentResource?.volume) {
        state.currentResource.volume.setVolume(state.volume);
      }
      await interaction.reply(`🔊 音量を ${percent}% に設定しました。`);
      break;
    }

    case 'shuffle': {
      if (state.queue.length < 2) {
        return interaction.reply({ content: '⚠️ シャッフルするには、キューに2曲以上必要です。', ephemeral: true });
      }
      for (let i = state.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
      }
      await interaction.reply(`🔀 キュー内の ${state.queue.length} 曲をシャッフルしました。`);
      break;
    }

    case 'back': {
      if (state.history.length === 0) {
        return interaction.reply({ content: '⚠️ 戻れる前の曲がありません。', ephemeral: true });
      }
      const prevSong = state.history.pop();
      if (state.currentSong) {
        state.queue.unshift(state.currentSong);
      }
      state.queue.unshift(prevSong);
      state.currentSong = null;
      state.skipRequested = true;
      if (state.currentProcess) {
        state.currentProcess.kill('SIGTERM');
        state.currentProcess = null;
      }
      if (state.player) state.player.stop();
      await interaction.reply(`⏮️ 前の曲に戻ります: **${prevSong.title}**`);
      break;
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
