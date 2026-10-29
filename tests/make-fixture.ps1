# Generates tests/fixtures/synthetic-mixed.wav (16 kHz mono) using Windows TTS.
# Uses a zh-TW/zh-CN voice for Chinese lines when one is installed; otherwise English only.
Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot 'fixtures\synthetic-mixed.wav'
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($out, $fmt)
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
$zh = $voices | Where-Object { $_.Culture.Name -like 'zh-*' } | Select-Object -First 1
$en = $voices | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1
$lines = @(
  @('en', 'Good morning everyone. Let us start the OQC weekly review.'),
  @('zh', '這週的 DPPM 有點超標，我們要開 NCR。'),
  @('en', 'The PN for the failing BMC board is still under investigation.'),
  @('zh', '請 QA 團隊在星期五之前完成 CAPA 報告。'),
  @('en', 'Action item: Patrick will send the FAI report by Thursday.'),
  @('en', 'That is all for today. Thank you.')
)
foreach ($l in $lines) {
  if ($l[0] -eq 'zh' -and $zh) { $synth.SelectVoice($zh.Name) } elseif ($en) { $synth.SelectVoice($en.Name) }
  if ($l[0] -eq 'zh' -and -not $zh) { continue }
  $synth.Speak($l[1])
  $synth.Speak(' ')
  Start-Sleep -Milliseconds 50
}
$synth.Dispose()
Write-Output "Wrote $out (Chinese voice: $([bool]$zh))"
