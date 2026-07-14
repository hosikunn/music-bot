// スラッシュコマンドをDiscordに登録するためのスクリプト
// 初回、またはコマンド内容を変更した時に `npm run deploy` で実行してください
require('dotenv').config();


const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('YouTubeの曲を再生(またはキューに追加)します')
    .addStringOption(option =>
      option.setName('keyword')
        .setDescription('曲名 または YouTubeのURL')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('omikuji')
    .setDescription('今日の運勢を占います'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('現在再生中の曲をスキップします'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('再生を停止してキューをクリアし、ボイスチャンネルから退出します'),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('再生を一時停止します'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('一時停止した再生を再開します'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('現在の再生キューを表示します'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('現在再生中の曲を表示します'),

  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('ループ再生の設定を変更します')
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('ループの種類')
        .setRequired(true)
        .addChoices(
          { name: 'オフ', value: 'off' },
          { name: '1曲ループ', value: 'track' },
          { name: 'キュー全体ループ', value: 'queue' },
        )),

  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('再生音量を変更します')
    .addIntegerOption(option =>
      option.setName('level')
        .setDescription('音量(0〜200のパーセント、100が通常)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200)),

  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('現在のキューの曲順をシャッフルします'),

  new SlashCommandBuilder()
    .setName('back')
    .setDescription('前に再生していた曲に戻ります'),
].map(command => command.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`スラッシュコマンドを登録中... (${commands.length}個)`);

    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);

    await rest.put(route, { body: commands });

    console.log('スラッシュコマンドの登録が完了しました。');
    if (process.env.GUILD_ID) {
      console.log('(GUILD_ID指定のため、即座に反映されます)');
    } else {
      console.log('(グローバル反映のため、全サーバーへの反映まで最大1時間程度かかる場合があります)');
    }
  } catch (error) {
    console.error('コマンド登録中にエラーが発生しました:', error);
  }
})();
