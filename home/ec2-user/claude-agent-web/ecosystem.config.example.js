module.exports = {
  apps: [{
    name: 'claude-agent-web',
    script: 'server.js',
    cwd: '/home/ec2-user/claude-agent-web',
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-api03-...',
      GOOGLE_CLIENT_ID: '....apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-...',
      CALLBACK_URL: 'https://<cloudfront-domain>/auth/google/callback',
      SESSION_SECRET: 'change-this-to-a-random-string',
      NODE_ENV: 'production',
      ADMIN_EMAILS: 'admin@acrovision.co.jp',
      PORT: 3000,
      HOME: '/home/ec2-user'
    }
  }]
}
