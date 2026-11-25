# Generates harder, meeting-like audio for the transcription replay (replay.html):
# fast speech, short gaps between sentences and speakers, a long monologue with no real pause,
# and a quiet speaker. The original make-audio.ps1 clips have 1.5 s pauses and slow speech,
# which hides the problems real meetings have.
#
#   realistic-en.wav / .txt    English only (a one-language meeting)
#   realistic-mixed.wav / .txt English and Japanese turns (a two-way meeting; needs the Haruka voice)
#
# The .txt files are the reference transcripts, one turn per line; the .wav files are gitignored.
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$esc = { param($t) [System.Security.SecurityElement]::Escape($t) }

# A turn: voice, volume (SSML prosody), gap after it in ms, sentences (joined by short breaks).
function T($voice, $volume, $gap, [string[]]$sentences) { @{ voice = $voice; volume = $volume; gap = $gap; sentences = $sentences } }

function Render($name, $turns) {
  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><break time="800ms"/>'
  $ref = @()
  foreach ($t in $turns) {
    $body = ($t.sentences | ForEach-Object { & $esc $_ }) -join '<break time="180ms"/>'
    $ssml += "<voice name=`"$($t.voice)`"><prosody rate=`"+15%`" volume=`"$($t.volume)`">$body</prosody></voice><break time=`"$($t.gap)ms`"/>"
    $ref += ($t.sentences -join ' ')
  }
  $ssml += '</speak>'
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SetOutputToWaveFile((Join-Path $here "$name.wav"), $fmt)
  $s.SpeakSsml($ssml)
  $s.Dispose()
  [IO.File]::WriteAllLines((Join-Path $here "$name.txt"), [string[]]$ref, (New-Object System.Text.UTF8Encoding($false)))
  $len = (Get-Item (Join-Path $here "$name.wav")).Length / 32000
  "$name.wav $([math]::Round($len, 1)) s, $($turns.Count) turns"
}

$en = @(
  (T 'Microsoft David Desktop' 'medium' 300 @(
    'Okay, I think everyone is here, so let us get going.',
    'We have three things today: the portal launch date, the data migration, and the support rota for March.')),
  (T 'Microsoft Zira Desktop' 'medium' 250 @(
    'On the launch date, the payment gateway is still failing in staging.',
    'The bank certificate expired last week and they have not sent the new one yet.',
    'I emailed them twice and called once, and the answer is always that it is with their security team.',
    'So realistically we cannot go live on the third of February unless that certificate arrives by Wednesday.')),
  (T 'Microsoft David Desktop' 'medium' 200 @(
    'Right, so the decision is that the third of February only holds if the certificate is here by Wednesday, otherwise we move to the tenth.')),
  (T 'Microsoft Hazel Desktop' 'x-soft' 300 @(
    'Sorry, can I just add something here?',
    'The tenth clashes with the finance freeze, so if we slip it should be the seventeenth, not the tenth.')),
  (T 'Microsoft David Desktop' 'medium' 250 @(
    'Good point, the seventeenth then.',
    'Next, the migration.')),
  (T 'Microsoft Zira Desktop' 'medium' 300 @(
    'The migration dry run finished on Monday and it took about six hours, which is longer than the four hour window we have on the night.',
    'Most of the time goes into the document attachments, roughly forty thousand files, and the index rebuild at the end.',
    'My suggestion is that we copy the attachments the weekend before, so on the night we only move the changes since then, and we rebuild the index after we reopen.',
    'That should bring it under three hours, but I would like one more dry run to prove it.')),
  (T 'Microsoft Hazel Desktop' 'x-soft' 250 @(
    'I can book the staging environment for a second dry run on Thursday night.')),
  (T 'Microsoft David Desktop' 'medium' 300 @(
    'Great, thank you. Last thing, the support rota.',
    'Two people are on leave in March, so we need someone to cover the evening shift on Tuesdays and Thursdays.',
    'Can I get a volunteer, or I will ask the team lead to assign it by Friday.'))
)
Render 'realistic-en' $en

$voices = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
if ($voices -contains 'Microsoft Haruka Desktop') {
  $mixed = @(
    (T 'Microsoft David Desktop' 'medium' 300 @(
      'Thanks for joining from Tokyo. Shall we start with the integration test results?')),
    (T 'Microsoft Haruka Desktop' 'medium' 250 @(
      'はい、結果を共有します。',
      '先週のテストでは、注文データの連携で三件のエラーがありました。',
      '原因は日付の形式で、日本側のシステムは年月日の順番で送っています。')),
    (T 'Microsoft Zira Desktop' 'medium' 250 @(
      'Understood. We can convert the date format on our side, that is a small change.',
      'We will deploy the fix to the test environment by Wednesday and send you a note when it is ready.')),
    (T 'Microsoft Haruka Desktop' 'x-soft' 300 @(
      'ありがとうございます。水曜日の午後にもう一度テストします。',
      'もう一つ、本番の切り替えは来月の十五日で問題ないでしょうか。')),
    (T 'Microsoft David Desktop' 'medium' 250 @(
      'The fifteenth works for us, as long as the second test passes.',
      'If it fails again, we will move the cutover by one week and tell you by Friday.')),
    (T 'Microsoft Haruka Desktop' 'medium' 300 @(
      '了解しました。では、金曜日までに結果を連絡します。'))
  )
  Render 'realistic-mixed' $mixed
} else { 'No Japanese voice (Microsoft Haruka Desktop): realistic-mixed.wav skipped.' }
