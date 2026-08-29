// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem};
use tauri::Emitter;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // ─── File 메뉴 ───
            let new_doc = MenuItemBuilder::with_id("new", "새 문서")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let open = MenuItemBuilder::with_id("open", "열기...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let save = MenuItemBuilder::with_id("save", "저장")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let save_as = MenuItemBuilder::with_id("save_as", "다른 이름으로 저장...")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let close_tab = MenuItemBuilder::with_id("close_tab", "탭 닫기")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "파일")
                .items(&[
                    &new_doc,
                    &open,
                    &PredefinedMenuItem::separator(app)?,
                    &save,
                    &save_as,
                    &PredefinedMenuItem::separator(app)?,
                    &close_tab,
                ])
                .build()?;

            // ─── Edit 메뉴 ───
            let edit_menu = SubmenuBuilder::new(app, "편집")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            // ─── View 메뉴 ───
            let toggle_jieum = MenuItemBuilder::with_id("toggle_jieum", "한자입력기 전환")
                .accelerator("CmdOrCtrl+\\")
                .build(app)?;

            let view_menu = SubmenuBuilder::new(app, "보기")
                .items(&[
                    &toggle_jieum,
                ])
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                ])
                .build()?;

            app.set_menu(menu)?;

            // 메뉴 이벤트 핸들러
            app.on_menu_event(move |app_handle, event| {
                let _ = app_handle.emit("menu-event", event.id().0.as_str());
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
