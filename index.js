'use strict';

const spawn = require('child_process').spawn;
const es = require('event-stream');

module.exports = function childrenOfPid(pid, callback) {
  let headers = null;

  if (typeof callback !== 'function') {
    throw new Error('childrenOfPid(pid, callback) expects callback');
  }

  if (typeof pid === 'number') {
    pid = pid.toString();
  }

  //
  // The `ps-tree` module behaves differently on *nix vs. Windows
  // by spawning different programs and parsing their output.
  //
  // Linux:
  // 1. " <defunct> " need to be striped
  // ```bash
  // $ ps -A -o comm,ppid,pid,stat
  // COMMAND          PPID   PID STAT
  // bbsd             2899 16958 Ss
  // watch <defunct>  1914 16964 Z
  // ps              20688 16965 R+
  // ```
  //
  // Darwin:
  // $ ps -A -o comm,ppid,pid,stat
  // COMM              PPID   PID STAT
  // /sbin/launchd        0     1 Ss
  // /usr/libexec/Use     1    43 Ss
  //
  // Win32:
  // 1. powershell Get-WmiObject -Class Win32_Process | Select-Object -Property Name,ProcessId,ParentProcessId,Status | Format-Table
  // 2. Outputs CSV with columns ParentProcessId,ProcessId,Status,Name (matching PPID,PID,STAT,COMMAND after normalization).
  // 3. Name column may contain spaces or commas; CSV parsing handles these reliably.
  // 4. Status column is usually empty. Output includes a header row, no dashes or empty lines.
  // ```shell
  // > powershell Get-CimInstance -Class Win32_Process | Select-Object -Property ParentProcessId,ProcessId,Status,Name | ConvertTo-Csv -NoTypeInformation
  // "ParentProcessId","ProcessId","Status","Name"
  // "0","0","","System Idle Process"
  // "567","1234","","svchost.exe"
  // "1234","5678","","C:\Program Files\App\app.exe"
  // ```

  const isWindows = process.platform === 'win32';
  let processLister;

  if (isWindows) {
    // WMIC is deprecated since 2016; using powershell 5.1
    processLister = spawn('powershell.exe', [
      'Get-CimInstance -Class Win32_Process | Select-Object -Property ParentProcessId,ProcessId,Status,Name | ConvertTo-Csv -NoTypeInformation',
    ]);
  } else {
    processLister = spawn('ps', ['-A', '-o', 'ppid,pid,stat,comm']);
  }

  es.connect(
    processLister.stdout,
    es.split(),
    es.map(function (line, cb) {
      const trimmedLine = line.trim();

      // Skip empty lines or header separator (for Linux/Darwin)
      if (trimmedLine.length === 0 || trimmedLine.includes('----')) {
        return cb();
      }

      if (headers === null) {
        // Extract headers (CSV for Windows, space-split for Linux/Darwin)
        const rawHeaders = isWindows ? parseCsvLine(trimmedLine) : trimmedLine.split(/\s+/);
        headers = rawHeaders.map(normalizeHeader);
        return cb();
      }

      // Extract columns (CSV for Windows, regex for Linux/Darwin)
      let columns;
      if (isWindows) {
        columns = parseCsvLine(trimmedLine);
      } else {
        const match = trimmedLine.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        columns = match ? match.slice(1) : [];
      }

      if (columns.length < headers.length) {
        return cb(); // Skip malformed lines
      }

      const row = {};
      headers.forEach((header, i) => {
        row[header] = columns[i] || '';
      });

      return cb(null, row);
    }),
    es.writeArray(function (err, ps) {
      var parents = {},
        children = [];

      parents[pid] = true;
      ps.forEach(function (proc) {
        if (parents[proc.PPID]) {
          parents[proc.PID] = true;
          children.push(proc);
        }
      });

      callback(null, children);
    })
  ).on('error', callback);
};

/**
 * Simple CSV line parser to handle quoted fields.
 * @param {string} line - The CSV line to parse.
 * @returns {string[]} Array of fields.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuote = false;
  for (let c of line) {
    if (c === '"') {
      inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      fields.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Normalizes the given header `str` from the Windows
 * title to the *nix title.
 *
 * @param {string} str Header string to normalize
 */
function normalizeHeader(str) {
  switch (str) {
    case 'Name': // for win32
    case 'COMM': // for darwin
      return 'COMMAND';
    case 'ParentProcessId':
      return 'PPID';
    case 'ProcessId':
      return 'PID';
    case 'Status':
      return 'STAT';
    default:
      return str;
  }
}
