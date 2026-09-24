# Private ClamAV service

Run `sudo bash install.sh` on a dedicated Ubuntu 24.04 host with at least 4 GB RAM.
This installs the distribution's ClamAV and Freshclam services, binds TCP to loopback,
caps clamd at 3 GB/one CPU and its updater at 1 GB/half a CPU, and checks loaded
signature freshness every minute. The full service unit replaces Ubuntu socket
activation; the socket is masked so requests cannot restart a stale scanner.
No provisioner or billable resource is created by these files.

Use an SSH tunnel from the application host to `127.0.0.1:3310` on the scanner host.
Use a dedicated SSH key restricted with `restrict,port-forwarding,permitopen="127.0.0.1:3310"`
and an account with no interactive shell; restrict source IP as well. Pin the host key.
Run the tunnel under systemd with `Restart=always`, `ExitOnForwardFailure=yes`,
`ServerAliveInterval=15`, and `ServerAliveCountMax=3`. Never expose port 3310 publicly.
Configure the application's inspector to use the local tunnel endpoint.

Freshclam validates and updates definitions. The watchdog stops clamd if loaded daily
signatures are over 48 hours old or PING fails. It restarts a stopped daemon only when
sigtool reports a recent daily database. UTC timezone is required on the host.
Monitor failed watchdog units, Freshclam logs, memory, and the application's dead-letter
queue. A watchdog failure is operationally significant even if the application is up.

Before routing production scans, test a clean file, the harmless EICAR test signature,
an encrypted archive, and an archive exceeding configured limits. Confirm scanner
shutdown leaves jobs quarantined and a restored scanner releases only clean files.
The health and installation scripts need validation on the target host before activation.

Configuration references: https://docs.clamav.net/manual/Usage/Configuration.html and
https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample.

A shared platform host with measured spare capacity may run the service too. Reserve
3 GB for clamd plus updater overhead, apply CPU limits appropriate to the host, and
keep application traffic authenticated and rate limited before reaching the daemon.
Do not expose clamd directly to untrusted tenant workloads. A separate droplet is
not required when those isolation and capacity conditions hold.
