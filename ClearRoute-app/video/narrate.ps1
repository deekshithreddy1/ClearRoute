$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$videoRoot = Split-Path $PSScriptRoot -Parent
$audioDirectory = Join-Path $videoRoot 'output/video/build'
New-Item -ItemType Directory -Force $audioDirectory | Out-Null
$scenes = Get-Content (Join-Path $PSScriptRoot 'scenes.json') -Raw | ConvertFrom-Json
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speaker.SelectVoice('Microsoft Zira Desktop')
$speaker.Rate = 0
try {
  for ($index=0; $index -lt $scenes.Count; $index++) {
    $speaker.SetOutputToWaveFile((Join-Path $audioDirectory ('voice-{0}.wav' -f $index)))
    $speaker.Speak($scenes[$index].narration)
    $speaker.SetOutputToNull()
  }
} finally { $speaker.Dispose() }
Write-Host 'Narration rendered for all nine scenes.'
