// Copyright (c) 2026 Hygor Ostrowskij de Morais <hygor.o.morais@gmail.com>

const
    EM_SETRECT = $00B3;


function SendMessageRect(hWnd: HWND; Msg: UINT; wParam: LongInt; var lParam: TRect): LongInt;
external 'SendMessageW@user32.dll';


function GetWindowLongW(hWnd: HWND; nIndex: Integer): LongInt;
external 'GetWindowLongW@user32.dll';


function SetWindowLongW(hWnd: HWND; nIndex: Integer; dwNewLong: LongInt): LongInt;
external 'SetWindowLongW@user32.dll';


procedure SetRichEditPadding(Memo: TRichEditViewer; PaddingTop: Integer; PaddingRight: Integer; PaddingBottom: Integer; PaddingLeft: Integer);
var
    Rect: TRect;
begin
    Rect.Top    := 0;
    Rect.Right  := Memo.ClientWidth;
    Rect.Bottom := Memo.ClientHeight;
    Rect.Left   := 0;

    Rect.Top    := Rect.Top    + PaddingTop;
    Rect.Right  := Rect.Right  - PaddingRight;
    Rect.Bottom := Rect.Bottom - PaddingBottom;
    Rect.Left   := Rect.Left   + PaddingLeft;

    SendMessageRect(Memo.Handle, EM_SETRECT, 0, Rect);
end;


function InitializeSetup(): Boolean;
begin
    Result := true;
end;


procedure InitializeWizard();
begin
    if WizardForm.LicenseMemo <> nil then
    begin
        SetRichEditPadding(WizardForm.LicenseMemo, 20, 20, 20, 20);
    end;
end;
