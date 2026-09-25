// PM2 process definition. Runs the Next.js production server on port 3005.
// Env is loaded by Next from the project's .env at runtime.
module.exports = {
  apps: [
    {
      name: "bahnfinder",
      cwd: "/srv/bahn-finder",
      script: "node_modules/next/dist/bin/next",
      // Only reachable via Apache on this host (not just firewalled): the login
      // rate limit trusts the X-Forwarded-For entry Apache appends.
      args: "start -p 3005 -H 127.0.0.1",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
