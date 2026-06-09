const net = require('net');

const DB_PORTS    = [3306, 5432, 27017, 6379, 1433];
const OTHER_PORTS = [21, 23, 8080, 3000, 4200, 8000];

const PORT_NAMES = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet',
  3000: 'Dev server', 3306: 'MySQL', 4200: 'Dev server',
  5432: 'PostgreSQL', 6379: 'Redis', 8000: 'Dev server',
  8080: 'HTTP alt', 1433: 'MSSQL', 27017: 'MongoDB',
};

function checkPort(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => finish(true));
    socket.on('error',   () => finish(false));
    socket.on('timeout', () => finish(false));
    socket.connect(port, host);
  });
}

function portLabel(port) {
  return PORT_NAMES[port] ? `${port} (${PORT_NAMES[port]})` : String(port);
}

module.exports = async function infraCheck(domain) {
  const [sshOpen, ...rest] = await Promise.all([
    checkPort(domain, 22),
    ...DB_PORTS.map(p    => checkPort(domain, p)),
    ...OTHER_PORTS.map(p => checkPort(domain, p)),
  ]);

  const dbOpen    = DB_PORTS.filter((_,  i) => rest[i]);
  const otherOpen = OTHER_PORTS.filter((_, i) => rest[DB_PORTS.length + i]);

  return [
    {
      name:   'SSH port (22) not publicly accessible',
      status: sshOpen ? 'FAIL' : 'PASS',
      details: sshOpen
        ? 'Port 22 (SSH) is open — restrict access to known IP addresses immediately to prevent brute-force attacks'
        : 'Port 22 (SSH) is not accessible from the internet',
      timeToFix: sshOpen ? '15 minutes' : null,
    },
    {
      name:   'Database ports not publicly accessible',
      status: dbOpen.length === 0 ? 'PASS' : dbOpen.length === 1 ? 'WARNING' : 'FAIL',
      details: dbOpen.length === 0
        ? `All checked database ports (${DB_PORTS.join(', ')}) are closed`
        : `Open database port(s): ${dbOpen.map(portLabel).join(', ')} — databases must not be directly reachable from the internet`,
      timeToFix: dbOpen.length === 0 ? null : '15 minutes',
    },
    {
      name:   'Only standard web ports accessible',
      status: otherOpen.length === 0 ? 'PASS' : otherOpen.some(p => [21, 23].includes(p)) ? 'FAIL' : 'WARNING',
      details: otherOpen.length === 0
        ? 'No non-standard web ports detected — only expected services appear to be exposed'
        : `Non-standard port(s) open: ${otherOpen.map(portLabel).join(', ')} — close or firewall any services not intended to be public`,
      timeToFix: otherOpen.length === 0 ? null : '30 minutes',
    },
  ];
};
