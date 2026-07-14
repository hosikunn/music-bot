console.log('★★★ これは編集中のファイルです ★★★');
console.log('DEBUG: env変数の一覧 =', Object.keys(process.env).filter(k => k.includes('DISCORD') || k.includes('CLIENT')));
require('dotenv').config();
console.log('DEBUG: DISCORD_TOKEN の長さ =', process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.length : '未設定(undefined)');
console.log('DEBUG: DISCORD_TOKEN の最初の5文字 =', process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.slice(0, 5) : 'なし');
console.log('DEBUG: CLIENT_ID =', process.env.CLIENT_ID);
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
const play = require('play-dl');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// サーバー(guild)ごとの再生状態を保持するMap
// { connection, player, queue: [{title, url, requestedBy}], playing, voiceChannelId, textChannel }
const guildQueues = new Map();

function getQueue(guildId) {
  if (!guildQueues.has(guildId)) {
    guildQueues.set(guildId, {
      connection: null,
      player: null,
      queue: [],
      playing: false,
      textChannel: null,
    });
  }
  return guildQueues.get(guildId);
}

// 曲を1つ再生する(再生完了後は自動的に次の曲へ)
async function playNext(guildId) {
  const state = getQueue(guildId);

  if (state.queue.length === 0) {
    state.playing = false;
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

  try {
    const stream = await play.stream(song.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true,
    });
    resource.volume?.setVolume(0.5);

    state.player.play(resource);
    state.currentSong = song;

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

        if (play.yt_validate(keyword) === 'video') {
          const info = await play.video_info(keyword);
          songInfo = { title: info.video_details.title, url: info.video_details.url };
        } else {
          const results = await play.search(keyword, { limit: 1, source: { youtube: 'video' } });
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
            debug: true,
          });
          connection.on('debug', (message) => {
            console.log('[VOICE DEBUG]', message);
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
