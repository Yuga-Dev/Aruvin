<#
============================================================================
FILE: make-corpus.ps1
LOCATION: benchmarks/voice-architectures/shared/make-corpus.ps1
PURPOSE: Generate six nonprivate speech inputs offline as raw PCM.
ROLE IN PROJECT: Own only this package's new audio directory; never overwrite.
KEY COMPONENTS: System.Speech; 800 ms hesitation; exact hashes/end markers.
============================================================================
#>
param([string]$Output = (Join-Path $PSScriptRoot '../audio'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
if (Test-Path $Output) { throw 'CORPUS_OUTPUT_EXISTS' }
$null = New-Item -ItemType Directory -Path $Output
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}
function Speak-Trimmed([string]$Text) {
  $stream = New-Object System.IO.MemoryStream
  try {
    $synth.SetOutputToAudioStream($stream, $format)
    $synth.Speak($Text)
    $bytes = $stream.ToArray()
    $start = 0
    $end = $bytes.Length
    while ($start + 1 -lt $end -and $bytes[$start] -eq 0 -and $bytes[$start+1] -eq 0) { $start += 2 }
    while ($end -ge $start + 2 -and $bytes[$end-1] -eq 0 -and $bytes[$end-2] -eq 0) { $end -= 2 }
    if ($end -le $start) { throw 'EMPTY_SYNTHESIS' }
    $result = New-Object byte[] ($end - $start)
    [Array]::Copy($bytes, $start, $result, 0, $end - $start)
    return ,$result
  } finally { $synth.SetOutputToNull(); $stream.Dispose() }
}
$texts = @(
  'Hello Aurvin, please confirm you can hear me in one short sentence.',
  'In two short sentences, explain why the sky looks blue.',
  'And in one short sentence, why does it look orange at sunset?',
  'Wait [800 ms pause] why do clouds look white?',
  'In four complete sentences, explain how the water cycle moves water from oceans to rain.',
  'Stop, just tell me what evaporation means in one sentence.'
)
$turns = @()
try {
  for ($i = 0; $i -lt 6; $i++) {
    if ($i -eq 3) {
      $a = Speak-Trimmed 'Wait'
      $b = Speak-Trimmed 'why do clouds look white?'
      $spoken = New-Object byte[] ($a.Length + 25600 + $b.Length)
      [Array]::Copy($a, 0, $spoken, 0, $a.Length)
      [Array]::Copy($b, 0, $spoken, $a.Length + 25600, $b.Length)
    } else { $spoken = Speak-Trimmed $texts[$i] }
    $length = [int]([Math]::Ceiling(($spoken.Length + 64000) / 2560.0) * 2560)
    $pcm = New-Object byte[] $length
    [Array]::Copy($spoken, $pcm, $spoken.Length)
    $file = Join-Path $Output "$i.pcm"
    [System.IO.File]::WriteAllBytes($file, $pcm)
    $turns += @{ index=$i; file="$i.pcm"; text=$texts[$i];
      sha256=(Get-Sha256 $file);
      speechEndMs=$spoken.Length / 32.0; hesitationMs=$(if ($i -eq 3) {800} else {0}) }
  }
  @{ sampleRate=16000; channels=1; encoding='pcm16le';
    generatorVoice=$synth.Voice.Name; turns=$turns } |
    ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Output 'manifest.json')
} finally { $synth.Dispose() }
