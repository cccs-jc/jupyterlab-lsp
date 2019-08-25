import { JupyterLabWidgetAdapter } from './jupyterlab';
import { FileEditor } from '@jupyterlab/fileeditor';
import { IDocumentWidget } from '@jupyterlab/docregistry';
import { FileEditorJumper } from '@krassowski/jupyterlab_go_to_definition/lib/jumpers/fileeditor';
import { CodeMirror } from './codemirror';
import { LspWsConnection } from 'lsp-editor-adapter';
import { JupyterFrontEnd } from '@jupyterlab/application';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { ICompletionManager } from '@jupyterlab/completer';
import { LSPConnector } from '../completion';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { VirtualFileEditor } from '../virtual/editors/file_editor';

export class FileEditorAdapter extends JupyterLabWidgetAdapter {
  editor: FileEditor;
  jumper: FileEditorJumper;
  main_connection: LspWsConnection;
  virtual_editor: VirtualFileEditor;

  get document_path() {
    return this.widget.context.path;
  }

  get language() {
    return this.jumper.language;
  }

  get_document_content(): string {
    return this.cm_editor.getValue();
  }

  get ce_editor(): CodeMirrorEditor {
    return this.editor.editor as CodeMirrorEditor;
  }

  get cm_editor(): CodeMirror.Editor {
    return this.ce_editor.editor;
  }

  find_ce_editor(cm_editor: CodeMirror.Editor): CodeEditor.IEditor {
    return this.editor.editor;
  }

  constructor(
    editor_widget: IDocumentWidget<FileEditor>,
    jumper: FileEditorJumper,
    app: JupyterFrontEnd,
    completion_manager: ICompletionManager,
    rendermime_registry: IRenderMimeRegistry
  ) {
    super(app, rendermime_registry, 'completer:invoke-file');
    this.jumper = jumper;
    this.widget = editor_widget;
    this.editor = editor_widget.content;

    this.virtual_editor = new VirtualFileEditor(this.language, this.cm_editor);

    this.connect(this.virtual_editor.virtual_document).then();
    this.create_adapter();

    const connector = new LSPConnector({
      editor: this.editor.editor,
      connection: this.main_connection,
      coordinates_transform: null
    });
    completion_manager.register({
      connector,
      editor: this.editor.editor,
      parent: editor_widget
    });
  }

  get path() {
    return this.widget.context.path;
  }
}
