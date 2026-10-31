const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

const profile = (process.argv[2] || 'personal').trim().toLowerCase();
if (!['personal', 'public'].includes(profile)) {
    console.error('Choose personal or public.');
    process.exit(2);
}

const directory = profile === 'personal' ? 'runtime' : path.join('runtime', 'public');
const qrPath = path.join(__dirname, directory, 'pairing_qr.txt');
if (!fs.existsSync(qrPath)) {
    console.error(`${profile} QR is not available. Check the bridge status or use its pairing code.`);
    process.exit(1);
}

console.log(profile === 'personal'
    ? "PERSONAL BRIDGE — scan with the owner's WhatsApp account"
    : "LILY BRIDGE — scan with Lily's WhatsApp account");
qrcode.generate(fs.readFileSync(qrPath, 'utf8').trim(), { small: true });
