; Inno Setup Script for Hs-WinClaw
; Build: dotnet publish -c Release -r win-x64 --self-contained
; Compile: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss
;
; Version is read from the VERSION file at compile time.
; The build_installer.bat script keeps VERSION in sync.

#define MyAppName "Hs-WinClaw"
#define FileHandle FileOpen(AddBackslash(SourcePath) + "VERSION")
#define MyAppVersion FileRead(FileHandle)
#expr FileClose(FileHandle)
#define MyAppPublisher "Hs-WinClaw"
#define MyAppExeName "Hs-WinClaw.exe"
#define PublishDir "publish\win-x64"
#define MyAppId "{{A3B5C7D9-1234-5678-9ABC-DEF012345678}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=installer
OutputBaseFilename=Hs-WinClaw-Setup-{#MyAppVersion}
SetupIconFile=src\HsWinClaw.Desktop\Assets\app.ico
UninstallDisplayIcon=src\HsWinClaw.Desktop\Assets\app.ico
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
CloseApplications=yes
RestartApplications=no
AppendDefaultDirName=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs restartreplace
; Built-in skills ship with the app so a fresh install is fully functional.
; On upgrade InstallDelete clears the old skills tree first (below).
Source: "skills\builtin\*"; DestDir: "{app}\skills\builtin"; Flags: ignoreversion recursesubdirs createallsubdirs restartreplace

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
; Silent installs (in-app auto-update) skip the wizard finish page, so the
; "launch after install" checkbox never appears — launch the new build here.
Filename: "{app}\{#MyAppExeName}"; Flags: nowait postinstall runasoriginaluser; Check: WizardSilent

; On upgrade, clean old program artifacts but preserve user data files
[InstallDelete]
Type: filesandordirs; Name: "{app}\skills"
Type: filesandordirs; Name: "{app}\wwwroot-rag"
Type: filesandordirs; Name: "{app}\runtimes"
Type: files; Name: "{app}\*.dll"
Type: files; Name: "{app}\*.exe"
Type: files; Name: "{app}\*.pdb"
Type: files; Name: "{app}\*.config"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\data"

[Code]
var
  PreviousVersion: String;
  IsUpgradeMode: Boolean;

// ============================================================
// StringSplit: split string by delimiter into array
// ============================================================
function StringSplit(S, Delim: String): TArrayOfString;
var
  I, Count, Start: Integer;
  Parts: TArrayOfString;
begin
  Count := 1;
  for I := 1 to Length(S) do
    if S[I] = Delim then Count := Count + 1;

  SetArrayLength(Parts, Count);
  Start := 1;
  Count := 0;
  for I := 1 to Length(S) do
  begin
    if S[I] = Delim then
    begin
      Parts[Count] := Copy(S, Start, I - Start);
      Count := Count + 1;
      Start := I + 1;
    end;
  end;
  Parts[Count] := Copy(S, Start, Length(S) - Start + 1);
  Result := Parts;
end;

// ============================================================
// CompareVersions: returns -1 (v1<v2), 0 (equal), 1 (v1>v2)
// ============================================================
function CompareVersions(V1, V2: String): Integer;
var
  Parts1, Parts2: TArrayOfString;
  I, Len, P1, P2: Integer;
begin
  Result := 0;
  // Normalize: replace hyphens with dots for pre-release versions
  StringChange(V1, '-', '.');
  StringChange(V2, '-', '.');

  Parts1 := StringSplit(V1, '.');
  Parts2 := StringSplit(V2, '.');
  Len := GetArrayLength(Parts1);
  if GetArrayLength(Parts2) > Len then
    Len := GetArrayLength(Parts2);

  for I := 0 to Len - 1 do
  begin
    if I < GetArrayLength(Parts1) then
      P1 := StrToIntDef(Parts1[I], 0)
    else
      P1 := 0;
    if I < GetArrayLength(Parts2) then
      P2 := StrToIntDef(Parts2[I], 0)
    else
      P2 := 0;

    if P1 > P2 then begin Result := 1; Exit; end;
    if P1 < P2 then begin Result := -1; Exit; end;
  end;
end;

// ============================================================
// GetInstalledVersion: read from registry uninstall key
// ============================================================
function GetInstalledVersion(): String;
var
  UninstallKey, Val: String;
begin
  Result := '';
  UninstallKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1';
  if RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', Val) then
  begin
    Result := Val;
    Exit;
  end;
  if RegQueryStringValue(HKLM, UninstallKey, 'DisplayVersion', Val) then
  begin
    Result := Val;
    Exit;
  end;
end;

// ============================================================
// KillProcess: graceful then force, with retry (up to 3 times)
// ============================================================
procedure KillProcess(ProcessName: String);
var
  ResultCode: Integer;
  I: Integer;
begin
  for I := 1 to 3 do
  begin
    // First attempt: graceful (no /F)
    Exec('taskkill.exe', '/IM ' + ProcessName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1500);

    // Force kill on second attempt
    if I >= 2 then
    begin
      Exec('taskkill.exe', '/F /IM ' + ProcessName, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Sleep(1500);
      Break;
    end;
  end;
end;

// ============================================================
// BackupUserConfig: save credentials before upgrade
// ============================================================
procedure BackupUserConfig();
var
  AppDataDir, BackupDir: String;
begin
  AppDataDir := ExpandConstant('{userappdata}\Hs-WinClaw');
  BackupDir := AppDataDir + '\backup';

  if DirExists(AppDataDir) then
  begin
    ForceDirectories(BackupDir);
    if FileExists(AppDataDir + '\credentials.dat') then
      CopyFile(AppDataDir + '\credentials.dat', BackupDir + '\credentials.dat.bak', False);
  end;
end;

// ============================================================
// InitializeSetup: detect version, show prompts, kill processes
// ============================================================
function InitializeSetup(): Boolean;
var
  CmpResult: Integer;
  Msg: String;
begin
  Result := True;
  IsUpgradeMode := False;
  PreviousVersion := '';

  PreviousVersion := GetInstalledVersion();

  if PreviousVersion <> '' then
  begin
    IsUpgradeMode := True;
    CmpResult := CompareVersions('{#MyAppVersion}', PreviousVersion);

    // In silent mode (in-app auto-update) never prompt: the manifest only
    // ever points at a newer version, and repair installs are harmless.
    // With /SUPPRESSMSGBOXES MsgBox would auto-return No and abort setup.
    if not WizardSilent() then
    begin
      if CmpResult < 0 then
      begin
        Msg := 'Detected installed version ' + PreviousVersion + #13#10 + 'Current installer version: ' + '{#MyAppVersion}' + #13#10#13#10 + 'This is a downgrade, which may cause data incompatibility.' + #13#10 + 'Continue anyway?';
        if MsgBox(Msg, mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDNO then
        begin
          Result := False;
          Exit;
        end;
      end
      else if CmpResult = 0 then
      begin
        Msg := 'Detected same version ' + PreviousVersion + ' already installed.' + #13#10#13#10 + 'Will perform a repair install. Continue?';
        if MsgBox(Msg, mbConfirmation, MB_YESNO or MB_DEFBUTTON1) = IDNO then
        begin
          Result := False;
          Exit;
        end;
      end;
    end;
  end;

  // Kill running instances before install
  KillProcess('Hs-WinClaw.exe');
  KillProcess('HsRag.Api.exe');
  Sleep(1000);
end;

// ============================================================
// PrepareToInstall: backup config before file operations
// ============================================================
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if IsUpgradeMode then
    BackupUserConfig();
end;

// ============================================================
// CurPageChanged: customize welcome page for upgrade
// ============================================================
procedure CurPageChanged(CurPageID: Integer);
var
  Msg: String;
begin
  if (CurPageID = wpWelcome) and IsUpgradeMode then
  begin
    if CompareVersions('{#MyAppVersion}', PreviousVersion) > 0 then
      Msg := 'Detected installed version ' + PreviousVersion + ', upgrading to ' + '{#MyAppVersion}' + #13#10#13#10 + 'Your settings and knowledge base data will be preserved.'
    else
      Msg := 'Detected installed version ' + PreviousVersion + ', performing repair install.' + #13#10#13#10 + 'Your settings and knowledge base data will be preserved.';

    WizardForm.WelcomeLabel2.Caption := Msg;
  end;
end;

// ============================================================
// CurStepChanged: show progress feedback
// ============================================================
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    if IsUpgradeMode then
      WizardForm.StatusLabel.Caption := 'Updating program files...'
    else
      WizardForm.StatusLabel.Caption := 'Installing program files...';
  end;
end;

// ============================================================
// Uninstall: ask user whether to keep data and config
// ============================================================
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDataDir, RagDir: String;
  KeepData, KeepConfig: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    AppDataDir := ExpandConstant('{userappdata}\Hs-WinClaw');
    RagDir := AppDataDir + '\rag';

    // Ask about knowledge base data
    if DirExists(RagDir) then
    begin
      KeepData := MsgBox(
        'Keep your knowledge base data?' + #13#10 + 'Choosing No will permanently delete all knowledge bases, documents and vector indexes.' + #13#10#13#10 + 'Click Yes to keep data (default).' + #13#10 + 'Click No to delete all data.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON1);

      if KeepData = IDNO then
        DelTree(RagDir, True, True, True);
    end;

    // Ask about user configuration (credentials)
    if FileExists(AppDataDir + '\credentials.dat') then
    begin
      KeepConfig := MsgBox(
        'Keep your user settings (API keys, etc.)?' + #13#10#13#10 + 'Click Yes to keep settings (default).' + #13#10 + 'Click No to delete all settings.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON1);

      if KeepConfig = IDNO then
      begin
        DeleteFile(AppDataDir + '\credentials.dat');
        DelTree(AppDataDir + '\backup', True, True, True);
      end;
    end;
  end;
end;
