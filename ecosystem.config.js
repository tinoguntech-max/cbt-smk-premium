module.exports = {
  apps: [{
    name: 'lms-smkn1kras',
    script: './src/server.js',
    instances: 'max', // Gunakan semua CPU cores
    exec_mode: 'cluster', // Cluster mode untuk load balancing
    watch: false, // Disable watch di production
    max_memory_restart: '1G', // Restart jika memory > 1GB
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    listen_timeout: 3000,
    kill_timeout: 5000,
    // Graceful shutdown
    shutdown_with_message: true,
    wait_ready: true,
    // Cron restart (optional - restart setiap hari jam 3 pagi)
    cron_restart: '0 3 * * *',
    // Environment variables
    env_file: '.env'
  }]
};
