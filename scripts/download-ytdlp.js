// npm install 後に自動実行され、yt-dlp の実行ファイルをダウンロードします
const https = require('https');
const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp');
const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

function download(url, dest, redirectCount = 0) {
  if (redirectCount > 5) {
    console.error('yt-dlp のダウンロードに失敗しました(リダイレクトが多すぎます)');
    return;
  }

  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      download(res.headers.location, dest, redirectCount + 1);
      return;
    }

    if (res.statusCode !== 200) {
      console.error(`yt-dlp のダウンロードに失敗しました(status: ${res.statusCode})`);
      return;
    }

    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => {
      file.close(() => {
        fs.chmodSync(dest, 0o755);
        console.log('✅ yt-dlp のダウンロードが完了しました。');
      });
    });
  }).on('error', (err) => {
    console.error('yt-dlp のダウンロード中にエラーが発生しました:', err);
  });
}

// Windows上ではこのスクリプトは動作確認不要(ローカルではffmpeg-staticのみで十分な場合が多いですが、
// yt-dlpコマンドが無いとエラーになるため、Windowsで直接実行する場合は手動でyt-dlp.exeを
// bin/yt-dlp.exe として配置してください)
if (process.platform === 'win32') {
  console.log('Windows環境のため、yt-dlpの自動ダウンロードはスキップされます。');
  console.log('ローカルでのテスト時は https://github.com/yt-dlp/yt-dlp/releases から yt-dlp.exe を取得し、bin フォルダに配置してください。');
} else {
  download(DOWNLOAD_URL, BIN_PATH);
}
