#define MyAppName "지음"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "온고컴퍼니"
#define MyAppURL "https://jieum.ongo.kr"

#ifndef SourceRoot
  #error SourceRoot is required
#endif

[Setup]
AppId={{D0B8900B-84E4-4D51-A4B3-6248DBA4B7D6}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\Jieum
DefaultGroupName=지음
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#SourceRoot}\output
OutputBaseFilename=Jieum-0.1.0-Windows-x64-setup
SetupIconFile={#SourceRoot}\icon.ico
UninstallDisplayIcon={app}\x64\jieum-tip-host.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
CloseApplications=yes
RestartApplications=no
RestartIfNeededByRun=no
VersionInfoVersion=0.1.0.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=지음 한자 입력기 설치 프로그램
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Files]
Source: "{#SourceRoot}\payload\x64\jieum_tip.dll"; DestDir: "{app}\x64"; Flags: ignoreversion regserver 64bit restartreplace
Source: "{#SourceRoot}\payload\x64\jieum-tip-host.exe"; DestDir: "{app}\x64"; Flags: ignoreversion restartreplace
Source: "{#SourceRoot}\payload\x64\libhangul.dll"; DestDir: "{app}\x64"; Flags: ignoreversion restartreplace
Source: "{#SourceRoot}\payload\x86\jieum_tip.dll"; DestDir: "{app}\x86"; Flags: ignoreversion regserver 32bit restartreplace
Source: "{#SourceRoot}\payload\x86\jieum-tip-host.exe"; DestDir: "{app}\x86"; Flags: ignoreversion restartreplace
Source: "{#SourceRoot}\payload\x86\libhangul.dll"; DestDir: "{app}\x86"; Flags: ignoreversion restartreplace
Source: "{#SourceRoot}\payload\engine\jieum-engine.exe"; DestDir: "{app}\engine"; Flags: ignoreversion restartreplace
Source: "{#SourceRoot}\payload\engine\start-engine.cmd"; DestDir: "{app}\engine"; Flags: ignoreversion
Source: "{#SourceRoot}\payload\dict\*"; DestDir: "{app}\dict"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\payload\support\configure-user.ps1"; DestDir: "{app}\support"; Flags: ignoreversion
Source: "{#SourceRoot}\payload\support\cleanup-user.ps1"; DestDir: "{app}\support"; Flags: ignoreversion

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\support\configure-user.ps1"" -InstallDir ""{app}"""; StatusMsg: "지음 엔진을 시작하고 있습니다..."; Flags: runasoriginaluser waituntilterminated; Check: ShouldConfigureUser

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\support\cleanup-user.ps1"""; Flags: waituntilterminated runhidden

[Code]
function ShouldConfigureUser: Boolean;
var
  I: Integer;
begin
  Result := True;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/SKIPUSERCONFIG') = 0 then
      Result := False;
end;

procedure StopProcess(const ImageName: String);
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM "' + ImageName + '"', '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopProcess('jieum-engine.exe');
  StopProcess('jieum-tip-host.exe');
  Result := '';
end;
