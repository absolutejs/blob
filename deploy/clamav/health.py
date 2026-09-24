#!/usr/bin/env python3
"""Check loaded signature timestamp; stop daemon on stale definitions.
If stopped, restart only after freshclam has provided a recent daily database.
"""
import datetime, glob, socket, subprocess, sys, time
LIMIT = 48 * 3600

def run(*args):
    return subprocess.run(args, check=False, capture_output=True, text=True)

def query(command):
    with socket.create_connection(('127.0.0.1',3310), timeout=10) as client:
        client.sendall(('z'+command+'\0').encode())
        result=b''
        while b'\0' not in result and len(result)<4096:
            part=client.recv(4096)
            if not part: raise RuntimeError('incomplete scanner reply')
            result+=part
        return result.decode().rstrip('\0')

try:
    if run('systemctl','is-active','clamav-daemon.service').returncode:
        recent=False
        for filename in glob.glob('/var/lib/clamav/daily.c[lv]d'):
            info=run('sigtool','--info',filename)
            for line in info.stdout.splitlines():
                if line.startswith('Build time: '):
                    stamp=datetime.datetime.strptime(line[12:].strip(),'%d %b %Y %H:%M %z')
                    age=time.time()-stamp.timestamp()
                    recent = recent or 0 <= age < LIMIT
        if not recent: raise RuntimeError('no recent verified daily definitions')
        run('systemctl','start','clamav-daemon.service')
        sys.exit(0) # Loaded database is checked on next tick after initialization.
    version=query('VERSION')
    stamp=datetime.datetime.strptime(version.rsplit('/',1)[1],'%a %b %d %H:%M:%S %Y').replace(tzinfo=datetime.timezone.utc)
    age=time.time()-stamp.timestamp()
    if not 0 <= age < LIMIT: raise RuntimeError('loaded definitions are older than 48 hours')
    if query('PING') != 'PONG': raise RuntimeError('scanner did not respond')
    print('ClamAV healthy; loaded definitions within 48 hours')
except Exception as error:
    run('systemctl','stop','clamav-daemon.service')
    print('ClamAV unavailable; scanning stopped:',str(error),file=sys.stderr)
    sys.exit(1)
