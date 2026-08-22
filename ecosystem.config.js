// PM2 ecosystem config for Obelisk production.
//
// Start the app:          pm2 start ecosystem.config.js
// Redeploy app only:      npm run deploy   (builds then restarts obelisk-dex)
//
// Env overrides (set in .env or shell before pm2 start):
//   PORT          — Next.js port (default: 3001)

module.exports = {
  apps: [
    {
      name: 'obelisk-dex',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3001 -H 127.0.0.1',
      cwd: '/root/obelisk-dex',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3001,
        HOSTNAME: '127.0.0.1',
      },
    },
  ],
};
