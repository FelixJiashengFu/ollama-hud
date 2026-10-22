# Ollama Cockpit - Windows-side telemetry sampler.
# Emits one compact JSON line per tick on stdout: CPU (total + per core, clock, RAPL package
# power/energy), RAM/commit/page file/hard faults, Ollama processes (serve / runner / clients)
# with CPU, memory, page faults, threads and disk I/O, and per-process GPU memory from the
# WDDM "GPU Process Memory" counters.
# server.ts starts it with -ParentPid; the loop exits once that process is gone.
param([int]$IntervalMs = 1000, [int]$ParentPid = 0)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CockpitNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessIoCounters(IntPtr hProcess, out IO_COUNTERS counters);

  [StructLayout(LayoutKind.Sequential)]
  public class MEMORYSTATUSEX {
    public uint dwLength = 64;
    public uint dwMemoryLoad;
    public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile;
    public ulong ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX status);

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_MEMORY_COUNTERS {
    public uint cb, PageFaultCount;
    public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage;
    public UIntPtr QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool K32GetProcessMemoryInfo(IntPtr hProcess, out PROCESS_MEMORY_COUNTERS counters, uint cb);
}
"@
$pmcSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][CockpitNative+PROCESS_MEMORY_COUNTERS])

function New-Counter($category, $name, $instance) {
  try {
    $c = New-Object System.Diagnostics.PerformanceCounter($category, $name, $instance)
    [void]$c.NextValue()
    return $c
  } catch { return $null }
}
function Read-Counter($c) { if ($c) { try { return $c.NextValue() } catch { } } return $null }

$logical = [Environment]::ProcessorCount
$cpuName = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
if ($cpuName) { $cpuName = $cpuName.Trim() }

# "% Processor Utility" is what Task Manager shows; fall back to "% Processor Time" if absent.
$cpuCounter = 'Processor Information'
$cpuMetric = '% Processor Utility'
$probe = New-Object System.Diagnostics.PerformanceCounter($cpuCounter, $cpuMetric, '_Total')
if ($null -eq $probe.NextValue()) { $cpuMetric = '% Processor Time' }
$cpuTotal = New-Object System.Diagnostics.PerformanceCounter($cpuCounter, $cpuMetric, '_Total')
$coreNames = (New-Object System.Diagnostics.PerformanceCounterCategory($cpuCounter)).GetInstanceNames() |
  Where-Object { $_ -notmatch '_Total' } |
  Sort-Object { [int]($_.Split(',')[0]) }, { [int]($_.Split(',')[-1]) }
$cores = @($coreNames | ForEach-Object { New-Object System.Diagnostics.PerformanceCounter($cpuCounter, $cpuMetric, $_) })
[void]$cpuTotal.NextValue(); foreach ($c in $cores) { [void]$c.NextValue() }

# Actual clock = nominal frequency x "% Processor Performance".
$cpuPerf = New-Counter $cpuCounter '% Processor Performance' '_Total'
$cpuFreq = New-Counter $cpuCounter 'Processor Frequency' '_Total'

# CPU package power from RAPL via the Windows "Energy Meter" counters (no admin needed).
# Power is the average over the sample interval in mW; Energy is cumulative in picowatt-hours.
$pkgPower = @(); $pkgEnergy = @()
try {
  $em = New-Object System.Diagnostics.PerformanceCounterCategory('Energy Meter')
  foreach ($n in $em.GetInstanceNames()) {
    if ($n -match '_PKG$') {
      $pkgPower += New-Counter 'Energy Meter' 'Power' $n
      $pkgEnergy += New-Object System.Diagnostics.PerformanceCounter('Energy Meter', 'Energy', $n)
    }
  }
} catch { }

# Page file ("swap") use and paging activity.
$pageUse = New-Counter 'Paging File' '% Usage' '_Total'
$hardFaults = New-Counter 'Memory' 'Pages Input/sec' ''
$pagesSec = New-Counter 'Memory' 'Pages/sec' ''
$faultsSec = New-Counter 'Memory' 'Page Faults/sec' ''
$pageFileMB = 0
$lastPageFileScan = [DateTime]::MinValue

$procInfo = @{}       # pid -> @{ role; cmd; port; proc; lastCpu; lastIo; lastFaults }
$gpuMemCounters = @{} # pid -> @(@{ ded; shr })
$lastScan = [DateTime]::MinValue
$lastTick = [DateTime]::UtcNow

function Get-Role($name, $cmd) {
  if ($name -eq 'llama-server.exe' -or $name -eq 'ollama_llama_server.exe') { return 'runner' }
  if ($cmd -match '\srunner(\s|$)') { return 'runner' }
  if ($cmd -match '\sserve(\s|$)') { return 'serve' }
  if ($name -eq 'ollama app.exe') { return 'tray' }
  return 'client'
}

function Update-GpuMemCounters {
  $script:gpuMemCounters = @{}
  $cat = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Process Memory')
  $names = $cat.GetInstanceNames()
  foreach ($procId in $procInfo.Keys) {
    $list = @()
    foreach ($n in $names) {
      if ($n -like "pid_$($procId)_*") {
        $list += @{
          ded = New-Object System.Diagnostics.PerformanceCounter('GPU Process Memory', 'Dedicated Usage', $n)
          shr = New-Object System.Diagnostics.PerformanceCounter('GPU Process Memory', 'Shared Usage', $n)
        }
      }
    }
    if ($list.Count) { $script:gpuMemCounters[$procId] = $list }
  }
}

function Update-Processes {
  $found = Get-CimInstance Win32_Process -Filter "Name='ollama.exe' OR Name='llama-server.exe' OR Name='ollama_llama_server.exe' OR Name='ollama app.exe'"
  $alive = @{}
  foreach ($w in $found) {
    $procId = [int]$w.ProcessId
    $alive[$procId] = $true
    if (-not $procInfo.ContainsKey($procId)) {
      $p = Get-Process -Id $procId
      if (-not $p) { continue }
      $cmd = [string]$w.CommandLine
      $port = $null
      $m = [regex]::Match($cmd, '--port[=\s]+(\d+)')
      if ($m.Success) { $port = [int]$m.Groups[1].Value }
      $procInfo[$procId] = @{
        role = Get-Role $w.Name $cmd; name = [string]$w.Name; cmd = $cmd; port = $port
        proc = $p; lastCpu = $p.TotalProcessorTime.TotalMilliseconds; lastIo = $null; lastFaults = $null
      }
    }
  }
  foreach ($procId in @($procInfo.Keys)) { if (-not $alive.ContainsKey($procId)) { $procInfo.Remove($procId) } }
  Update-GpuMemCounters
}

while ($true) {
  $tickStart = [DateTime]::UtcNow
  if ($ParentPid -and -not (Get-Process -Id $ParentPid)) { break }

  $now = [DateTime]::UtcNow
  $dtMs = [Math]::Max(1.0, ($now - $lastTick).TotalMilliseconds)
  $lastTick = $now

  $needScan = ($now - $lastScan).TotalSeconds -ge 3
  foreach ($info in $procInfo.Values) { if ($info.proc.HasExited) { $needScan = $true } }
  if ($needScan) { Update-Processes; $lastScan = $now }

  $total = [Math]::Min(100.0, $cpuTotal.NextValue())
  $coreVals = @($cores | ForEach-Object { [Math]::Round([Math]::Min(100.0, $_.NextValue()), 1) })

  $mem = New-Object CockpitNative+MEMORYSTATUSEX
  [void][CockpitNative]::GlobalMemoryStatusEx($mem)

  if (($now - $lastPageFileScan).TotalSeconds -ge 15) {
    $pageFileMB = (Get-CimInstance Win32_PageFileUsage | Measure-Object -Property AllocatedBaseSize -Sum).Sum
    $lastPageFileScan = $now
  }
  $pagePct = Read-Counter $pageUse

  $mhz = $null
  $perf = Read-Counter $cpuPerf; $nominal = Read-Counter $cpuFreq
  if ($perf -and $nominal) { $mhz = [Math]::Round($nominal * $perf / 100) }

  $cpuPowerW = $null; $cpuEnergyJ = $null
  if ($pkgEnergy.Count) {
    $cpuPowerW = 0; $cpuEnergyJ = 0
    foreach ($c in $pkgPower) { $cpuPowerW += (Read-Counter $c) / 1000.0 }
    foreach ($c in $pkgEnergy) { $cpuEnergyJ += $c.RawValue * 3.6e-9 } # pWh -> J
  }

  $procs = @()
  foreach ($procId in @($procInfo.Keys)) {
    $info = $procInfo[$procId]
    $p = $info.proc
    $p.Refresh()
    if ($p.HasExited) { continue }
    $cpuMs = $p.TotalProcessorTime.TotalMilliseconds
    $cpuPct = 100.0 * ($cpuMs - $info.lastCpu) / ($dtMs * $logical)
    $info.lastCpu = $cpuMs

    $readBps = $null; $writeBps = $null
    $io = New-Object CockpitNative+IO_COUNTERS
    if ([CockpitNative]::GetProcessIoCounters($p.Handle, [ref]$io)) {
      if ($info.lastIo) {
        $readBps = [Math]::Max(0, ($io.ReadTransferCount - $info.lastIo.ReadTransferCount)) * 1000.0 / $dtMs
        $writeBps = [Math]::Max(0, ($io.WriteTransferCount - $info.lastIo.WriteTransferCount)) * 1000.0 / $dtMs
      }
      $info.lastIo = $io
    }

    $faultsPerSec = $null; $peakWs = $null
    $pmc = New-Object CockpitNative+PROCESS_MEMORY_COUNTERS
    if ([CockpitNative]::K32GetProcessMemoryInfo($p.Handle, [ref]$pmc, $pmcSize)) {
      if ($null -ne $info.lastFaults) {
        $faultsPerSec = [Math]::Max(0, [double]$pmc.PageFaultCount - $info.lastFaults) * 1000.0 / $dtMs
      }
      $info.lastFaults = [double]$pmc.PageFaultCount
      $peakWs = [uint64]$pmc.PeakWorkingSetSize
    }

    $ded = $null; $shr = $null
    if ($gpuMemCounters.ContainsKey($procId)) {
      $ded = 0; $shr = 0
      foreach ($g in $gpuMemCounters[$procId]) { $ded += $g.ded.RawValue; $shr += $g.shr.RawValue }
    }

    $procs += [ordered]@{
      pid = $procId; name = $info.name; role = $info.role; port = $info.port
      cmd = $(if ($info.role -eq 'runner' -or $info.role -eq 'client') { $info.cmd } else { $null })
      cpu = [Math]::Round([Math]::Max(0, $cpuPct), 1)
      ws = $p.WorkingSet64; priv = $p.PrivateMemorySize64
      threads = $p.Threads.Count; handles = $p.HandleCount
      started = $p.StartTime.ToUniversalTime().ToString('o')
      ioRead = $readBps; ioWrite = $writeBps
      faults = $faultsPerSec; peakWs = $peakWs
      gpuDed = $ded; gpuShared = $shr
    }
  }

  $out = [ordered]@{
    t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    cpu = [ordered]@{
      name = $cpuName; logical = $logical; metric = $cpuMetric; total = [Math]::Round($total, 1); cores = $coreVals
      mhz = $mhz; power = $cpuPowerW; energyJ = $cpuEnergyJ
    }
    mem = [ordered]@{
      load = $mem.dwMemoryLoad; total = $mem.ullTotalPhys; avail = $mem.ullAvailPhys
      commitTotal = $mem.ullTotalPageFile; commitAvail = $mem.ullAvailPageFile
      swapTotal = $(if ($pageFileMB) { [double]$pageFileMB * 1MB } else { $null })
      swapUsed = $(if ($pageFileMB -and $null -ne $pagePct) { [double]$pageFileMB * 1MB * $pagePct / 100 } else { $null })
      hardFaults = Read-Counter $hardFaults; pagesSec = Read-Counter $pagesSec; faults = Read-Counter $faultsSec
    }
    procs = $procs
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()

  $spent = ([DateTime]::UtcNow - $tickStart).TotalMilliseconds
  $wait = [int]($IntervalMs - $spent)
  if ($wait -gt 10) { Start-Sleep -Milliseconds $wait }
}
