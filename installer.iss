[Setup]
AppId={{7E1B7C2A-4C7F-4D62-9F6B-1E3A5C8D9B10}
AppName=DBLion
AppVersion=0.1.0
AppPublisher=DBLion
SetupIconFile=icon.ico
DefaultDirName={localappdata}\Programs\DBLion
DefaultGroupName=DBLion
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=release
OutputBaseFilename=DBLion-Setup-0.1.0
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\DBLion.exe
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
Source: "release\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\DBLion"; Filename: "{app}\DBLion.exe"
Name: "{autodesktop}\DBLion"; Filename: "{app}\DBLion.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\DBLion.exe"; Description: "Launch DBLion"; Flags: nowait postinstall skipifsilent
