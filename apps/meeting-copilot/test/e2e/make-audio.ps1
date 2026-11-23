# Generates the fake meeting audio used by the Chrome end-to-end test.
# room.wav   -> fed to Chrome as the microphone (--use-file-for-fake-audio-capture)
# remote.wav -> played by fake-meeting.html, captured as "tab audio"
# mixed.wav  -> English and Japanese turns, for a two-way meeting (needs the Haruka ja-JP voice)
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voices = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }

function Speak($file, $voice, $lines) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($voice -and ($voices -contains $voice)) { $s.SelectVoice($voice) }
  $s.Rate = -1
  $s.SetOutputToWaveFile($file, $fmt)
  $pb = New-Object System.Speech.Synthesis.PromptBuilder
  $pb.AppendBreak([TimeSpan]::FromSeconds(1))
  foreach ($l in $lines) { $pb.AppendText($l); $pb.AppendBreak([TimeSpan]::FromMilliseconds(1500)) }
  $s.Speak($pb)
  $s.Dispose()
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Speak (Join-Path $here 'room.wav') 'Microsoft David Desktop' @(
  'Okay everyone, let us start. The main item today is the customer portal go live.',
  'The payment gateway still fails in testing because the bank certificate has expired.',
  'Wei Ming will chase the bank for the new certificate by Wednesday.',
  'If we do not get it by Wednesday, the go live moves from the third of February to the tenth of February.'
)
Speak (Join-Path $here 'remote.wav') 'Microsoft Zira Desktop' @(
  'Hi, this is Priya joining remotely. The accessibility audit found fourteen issues on the claims form.',
  'I will fix all of them by next Friday.',
  'Also, legal wants the old portal kept read only for six months. We agreed on six months.'
)
# Each turn is [voice, text]: the voice switches mid-file, as speakers do in a two-way meeting.
function SpeakTurns($file, $turns) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.Rate = -1
  $s.SetOutputToWaveFile($file, $fmt)
  $pb = New-Object System.Speech.Synthesis.PromptBuilder
  $pb.AppendBreak([TimeSpan]::FromSeconds(1))
  foreach ($t in $turns) {
    $pb.StartVoice($t[0]); $pb.AppendText($t[1]); $pb.EndVoice()
    $pb.AppendBreak([TimeSpan]::FromMilliseconds(1500))
  }
  $s.Speak($pb)
  $s.Dispose()
}
if ($voices -contains 'Microsoft Haruka Desktop') {
  SpeakTurns (Join-Path $here 'mixed.wav') @(
    @('Microsoft David Desktop', 'Okay everyone, let us start. The main item today is the customer portal go live.'),
    @('Microsoft Haruka Desktop', 'こんにちは、田中です。銀行の証明書が切れたため、支払いゲートウェイがまだテストで失敗しています。'),
    @('Microsoft David Desktop', 'Tanaka san, can you chase the bank for the new certificate by Wednesday?'),
    @('Microsoft Haruka Desktop', 'はい、今日銀行に連絡して、水曜日の朝にもう一度確認します。'),
    @('Microsoft David Desktop', 'Thanks. If we do not get it by Wednesday, the go live moves to the tenth of February.')
  )
} else { 'No Japanese voice (Microsoft Haruka Desktop): mixed.wav skipped. Add Japanese speech in Windows settings.' }
"Voices: $($voices -join ', ')"
Get-ChildItem $here -Filter *.wav | ForEach-Object { "$($_.Name) $([math]::Round($_.Length/32000,1)) s" }
