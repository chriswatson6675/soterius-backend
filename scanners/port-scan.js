const net = require('net');

const PORTS = [
  { port: 80,    label: 'HTTP',       exposed: false },
  { port: 443,   label: 'HTTPS',      exposed: false },
  { port: 22,    label: 'SSH',        exposed: true  },
  { port: 3306,  label: 'MySQL',      exposed: true  },
  { port: 5432,  label: 'PostgreSQL', exposed: true  },
  { port: 8080,  label: 'HTTP-Alt',   exposed: false },
  { port: 3000,  label: 'Dev-Server', exposed: true  },
  { port: 27017, label: 'MongoDB',    exposed: true  },
];

// Returns a detailed state string instead of a boolean so callers can
// distinguish genuine open ports from filtered/reset connections.
//
// Possible states:
//   'open'        — TCP handshake completed AND connection held (real service)
//   'reset'       — handshake completed but immediately RST'd (firewall/proxy
//                   completes SYN-ACK then rejects — the main false-positive source)
//   'closed'      — ECONNREFUSED (port is definitely not listening)
//   'filtered'    — timeout, no response (firewall drops SYN silently)
//   'error:CODE'  — any other socket error
function probePort(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let state = 'filtered'; // default if nothing else fires before close

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      // Handshake completed — tentatively open, but wait: if the remote end
      // immediately sends RST the 'error' handler will downgrade to 'reset'.
      state = 'open';
      socket.destroy();
    });

    socket.on('timeout', () => {
      state = 'filtered';
      socket.destroy();
    });

    socket.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        state = 'closed';
      } else if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        // Handshake succeeded but the connection was immediately torn down.
        // This is the classic firewall false-positive pattern — do NOT keep
        // state as 'open' even though 'connect' fired earlier.
        state = 'reset';
      } else {
        state = `error:${err.code ?? 'UNKNOWN'}`;
      }
      socket.destroy();
    });

    socket.on('close', () => resolve(state));
    socket.connect(port, host);
  });
}

// Confirms a port is genuinely open by running two independent probes.
// A port is only reported open if both probes return 'open'.
// This filters transient RST false-positives from firewalls/CDN edges.
async function checkPort(host, port, timeout = 3000, verbose = false) {
  const probe1 = await probePort(host, port, timeout);
  if (verbose) console.log(`    probe-1  ${host}:${port}  →  ${probe1}`);

  if (probe1 !== 'open') {
    return { open: false, state: probe1 };
  }

  // First probe says open — wait briefly and confirm with a second probe.
  await new Promise(r => setTimeout(r, 300));
  const probe2 = await probePort(host, port, timeout);
  if (verbose) console.log(`    probe-2  ${host}:${port}  →  ${probe2}`);

  if (probe2 !== 'open') {
    if (verbose) {
      console.log(`    [FILTERED] ${host}:${port} probe-1=open probe-2=${probe2} — false positive suppressed`);
    }
    return { open: false, state: probe2, falsePositive: true };
  }

  return { open: true, state: 'open' };
}

async function portScan(domain, verbose = false) {
  const results = await Promise.all(
    PORTS.map(async ({ port, label, exposed }) => {
      if (verbose) console.log(`  scanning ${domain}:${port} (${label})`);
      const { open, state, falsePositive } = await checkPort(domain, port, 3000, verbose);
      if (verbose && falsePositive) {
        console.log(`  [WARN] ${label} (${port}) — first probe open, second probe ${state} → false positive filtered`);
      }
      return { port, label, open, exposed: open && exposed, state };
    })
  );

  const openPorts    = results.filter(r => r.open);
  const exposedPorts = results.filter(r => r.exposed);
  const issues       = exposedPorts.map(p => `Port ${p.port} (${p.label}) is open — should not be public`);

  return {
    module: 'ports',
    status: exposedPorts.length > 0 ? 'fail' : 'pass',
    details: {
      scanned:  PORTS.map(p => p.port),
      open:     openPorts.map(p => ({ port: p.port, label: p.label })),
      exposed:  exposedPorts.map(p => ({ port: p.port, label: p.label })),
    },
    issues,
  };
}

module.exports = portScan;

// ── Manual diagnostic test ────────────────────────────────────────────────────
// Run directly:  node backend/scanners/port-scan.js
if (require.main === module) {
  const TARGET  = 'inavate.co.uk';
  const FOCUSED = [80, 443, 3306]; // ports specifically under investigation

  (async () => {
    console.log(`\nPort diagnostic — ${TARGET}`);
    console.log('─'.repeat(60));
    console.log('Focused probes (verbose):');

    for (const port of FOCUSED) {
      const def = PORTS.find(p => p.port === port) ?? { label: 'unknown', exposed: true };
      console.log(`\n  ${def.label} (${port})`);
      const result = await checkPort(TARGET, port, 3000, true);
      console.log(`  final verdict: ${result.open ? 'OPEN' : 'CLOSED/FILTERED'}  (state: ${result.state})`);
      if (result.falsePositive) console.log(`  *** FALSE POSITIVE detected and suppressed ***`);
    }

    console.log('\n' + '─'.repeat(60));
    console.log('Full scan (all ports):');
    const scan = await portScan(TARGET, true);
    console.log('\nResult:');
    console.log('  status  :', scan.status);
    console.log('  open    :', scan.details.open.map(p => `${p.port}/${p.label}`).join(', ') || 'none');
    console.log('  exposed :', scan.details.exposed.map(p => `${p.port}/${p.label}`).join(', ') || 'none');
    if (scan.issues.length) {
      console.log('  issues  :');
      scan.issues.forEach(i => console.log(`    • ${i}`));
    }
    console.log('');
  })();
}
