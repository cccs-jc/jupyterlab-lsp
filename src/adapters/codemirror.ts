export import CodeMirror = require('codemirror');
import {
  CodeMirrorAdapter,
  ILspConnection,
  ITextEditorOptions
} from 'lsp-editor-adapter';
import * as lsProtocol from 'vscode-languageserver-protocol';
import { FreeTooltip } from '../free_tooltip';
import { getModifierState } from '../utils';
import { PositionConverter } from '../converter';
import { diagnosticSeverityNames } from '../lsp';
import { VirtualEditor } from '../virtual/editor';

export type KeyModifier = 'Alt' | 'Control' | 'Shift' | 'Meta' | 'AltGraph';
// TODO: settings
const hover_modifier: KeyModifier = 'Control';
const default_severity = 2;

export class CodeMirrorAdapterExtension extends CodeMirrorAdapter {
  private marked_diagnostics: Map<string, CodeMirror.TextMarker> = new Map();
  protected create_tooltip: (
    markup: lsProtocol.MarkupContent,
    cm_editor: CodeMirror.Editor,
    position: CodeMirror.Position
  ) => FreeTooltip;
  private _tooltip: FreeTooltip;
  private show_next_tooltip: boolean;
  private last_hover_response: lsProtocol.Hover;
  private last_hover_character: CodeMirror.Position;
  editor: VirtualEditor;

  invoke_completer: Function;

  constructor(
    connection: ILspConnection,
    options: ITextEditorOptions,
    editor: VirtualEditor,
    create_tooltip: (
      markup: lsProtocol.MarkupContent,
      cm_editor: CodeMirror.Editor,
      position: CodeMirror.Position
    ) => FreeTooltip,
    invoke_completer: Function
  ) {
    super(connection, options, editor);
    this.create_tooltip = create_tooltip;
    this.invoke_completer = invoke_completer;

    // @ts-ignore
    let listeners = this.editorListeners;

    let wrapper = this.editor.getWrapperElement();
    // detach the adapters contextmenu
    wrapper.removeEventListener('contextmenu', listeners.contextmenu);

    // TODO: actually we only need the connection...
    //  the tooltips and suggestions will need re-writing to JL standards anyway

    // show hover after pressing the modifier key
    wrapper.addEventListener('keydown', (event: KeyboardEvent) => {
      if (
        (!hover_modifier || getModifierState(event, hover_modifier)) &&
        this.hover_character === this.last_hover_character
      ) {
        this.show_next_tooltip = true;
        this.handleHover(this.last_hover_response);
      }
    });

    wrapper.addEventListener('keyup', () => {
      // TODO: the updates frequency and triggers will require a review and a clean up
      this.connection.sendChange();
    });
  }

  get hover_character(): CodeMirror.Position {
    // @ts-ignore
    return this.hoverCharacter;
  }

  public handleGoTo(locations: any) {
    this.remove_tooltip();

    // do NOT handle GoTo actions here
  }

  public handleCompletion(completions: lsProtocol.CompletionItem[]) {
    // do NOT handle completion here
    // TODO: UNLESS the trigger character was typed!
  }

  protected static get_markup_for_hover(
    response: lsProtocol.Hover
  ): lsProtocol.MarkupContent {
    let contents = response.contents;

    // this causes the webpack to fail "Module not found: Error: Can't resolve 'net'" for some reason
    // if (lsProtocol.MarkedString.is(contents))
    ///  contents = [contents];

    if (typeof contents === 'string') {
      contents = [contents as lsProtocol.MarkedString];
    }

    if (!Array.isArray(contents)) {
      return contents as lsProtocol.MarkupContent;
    }

    // now we have MarkedString
    let content = contents[0];

    if (typeof content === 'string') {
      // coerce to MarkedString  object
      return {
        kind: 'plaintext',
        value: content
      };
    } else {
      return {
        kind: 'markdown',
        value: '```' + content.language + '\n' + content.value + '```'
      };
    }
  }

  protected remove_tooltip() {
    // @ts-ignore
    this._removeHover(); // this removes underlines

    if (this._tooltip !== undefined) {
      this._tooltip.dispose();
    }
  }

  public handleHover(response: lsProtocol.Hover) {
    this.remove_tooltip();

    if (
      !response ||
      !response.contents ||
      (Array.isArray(response.contents) && response.contents.length === 0)
    ) {
      return;
    }

    this.highlight_range(response.range, 'cm-lp-hover-available');

    this.last_hover_response = null;
    if (!this.show_next_tooltip) {
      this.last_hover_response = response;
      this.last_hover_character = this.hover_character;
      return;
    }

    const markup = CodeMirrorAdapterExtension.get_markup_for_hover(response);
    let position = this.hover_character;
    let cm_editor = this.get_cm_editor(position);

    this._tooltip = this.create_tooltip(markup, cm_editor, position);
  }

  get_cm_editor(position: CodeMirror.Position) {
    // TODO necessity to have dependency on position is where the idea of mapping notebooks
    //  with an object pretending to be an editor has a weak side...
    return this.editor.get_cm_editor(position);
  }

  get_language_at(position: CodeMirror.Position, editor?: CodeMirror.Editor) {
    if (typeof editor === 'undefined') {
      editor = this.editor;
    }
    return editor.getModeAt(position).name;
  }

  protected get_markup_for_signature_help(
    response: lsProtocol.SignatureHelp,
    language: string
  ): lsProtocol.MarkupContent {
    let signatures = new Array<string>();

    response.signatures.forEach((item: lsProtocol.SignatureInformation) => {
      let markdown = '```' + language + '\n' + item.label + '\n```';
      if (item.documentation) {
        markdown += '\n';
        // TODO: make use of the MarkupContent object instead
        for (let line of item.documentation.toString().split('\n')) {
          if (line.trim() === item.label.trim()) {
            continue;
          }
          if (line.startsWith('>>>')) {
            line = '```' + language + '\n' + line.substr(3) + '\n```';
          }
          markdown += line + '\n';
        }
      }
      signatures.push(markdown);
    });

    return {
      kind: 'markdown',
      value: signatures.join('\n\n')
    };
  }

  public handleSignature(response: lsProtocol.SignatureHelp) {
    this.remove_tooltip();

    // @ts-ignore
    let token = this.token;
    if (!token || !response || !response.signatures.length) {
      return;
    }

    let position: CodeMirror.Position = token.start;

    let language = this.get_language_at(position);
    let markup = this.get_markup_for_signature_help(response, language);
    let cm_editor = this.get_cm_editor(position);

    this._tooltip = this.create_tooltip(markup, cm_editor, position);
  }

  public handleChange(cm: CodeMirror.Editor, change: CodeMirror.EditorChange) {
    // based on https://github.com/wylieconlon/lsp-editor-adapter/blob/e80e44310f8c12f87f3da9be07772102610ce517/src/codemirror-adapter.ts#L65
    // ISC licence (TODO: move this to the fork to separate out the ISC code)
    this.remove_tooltip();

    const location = this.editor.getDoc().getCursor('end');
    this.connection.sendChange();

    const completionCharacters = this.connection.getLanguageCompletionCharacters();
    const signatureCharacters = this.connection.getLanguageSignatureCharacters();

    const code = this.editor.getValue();
    const lines = code.split('\n');
    const line = lines[location.line];
    const typedCharacter = line[location.ch - 1];

    if (completionCharacters.indexOf(typedCharacter) > -1) {
      this.invoke_completer();
    } else if (signatureCharacters.indexOf(typedCharacter) > -1) {
      // @ts-ignore
      this.token = this._getTokenEndingAtPosition(
        code,
        location,
        signatureCharacters
      );
      this.connection.getSignatureHelp(location);
    }
  }

  protected highlight_range(range: lsProtocol.Range, class_name: string) {
    let hover_character = this.hover_character;

    let start: CodeMirror.Position;
    let end: CodeMirror.Position;

    if (range) {
      start = PositionConverter.lsp_to_cm(range.start);
      end = PositionConverter.lsp_to_cm(range.end);
    } else {
      // construct range manually using the token information
      let token = this.editor.getTokenAt(hover_character);
      start = { line: hover_character.line, ch: token.start };
      end = { line: hover_character.line, ch: token.end };
    }

    // @ts-ignore
    this.hoverMarker = this.editor.getDoc().markText(start, end, {
      className: class_name
    });
  }

  public handleMouseOver(event: MouseEvent) {
    // proceed when no hover modifier or hover modifier pressed
    this.show_next_tooltip =
      !hover_modifier || getModifierState(event, hover_modifier);

    try {
      return super.handleMouseOver(event);
    } catch (e) {
      if (
        !(
          e.message === 'Cell not found in cell_line_map' ||
          e.message === "Cannot read property 'string' of undefined"
        )
      ) {
        throw e;
      }
    }
  }

  protected collapse_overlapping_diagnostics(
    diagnostics: lsProtocol.Diagnostic[]
  ): Map<lsProtocol.Range, lsProtocol.Diagnostic[]> {
    // because Range is not a primitive types, the equality of the objects having
    // the same parameters won't be compared (thus considered equal) in Map.

    // instead, a intermediate step of mapping through a stringified representation of Range is needed:
    // an alternative would be using nested [start line][start character][end line][end character] structure,
    // which would increase the code complexity, but reduce memory use and may be slightly faster.
    type RangeID = string;
    const range_id_to_range = new Map<RangeID, lsProtocol.Range>();
    const range_id_to_diagnostics = new Map<RangeID, lsProtocol.Diagnostic[]>();

    function get_range_id(range: lsProtocol.Range): RangeID {
      return (
        range.start.line +
        ',' +
        range.start.character +
        ',' +
        range.end.line +
        ',' +
        range.end.character
      );
    }

    diagnostics.forEach((diagnostic: lsProtocol.Diagnostic) => {
      let range = diagnostic.range;
      let range_id = get_range_id(range);
      range_id_to_range.set(range_id, range);
      if (range_id_to_diagnostics.has(range_id)) {
        let ranges_list = range_id_to_diagnostics.get(range_id);
        ranges_list.push(diagnostic);
      } else {
        range_id_to_diagnostics.set(range_id, [diagnostic]);
      }
    });

    let map = new Map<lsProtocol.Range, lsProtocol.Diagnostic[]>();

    range_id_to_diagnostics.forEach(
      (range_diagnostics: lsProtocol.Diagnostic[], range_id: RangeID) => {
        let range = range_id_to_range.get(range_id);
        map.set(range, range_diagnostics);
      }
    );

    return map;
  }

  public handleDiagnostic(response: lsProtocol.PublishDiagnosticsParams) {
    /*
    TODO: the base class has the gutter support, like this
    this.editor.clearGutter('CodeMirror-lsp');
     */

    // Note: no deep equal for Sets or Maps in JS:
    // https://stackoverflow.com/a/29759699
    const markers_to_retain: Set<string> = new Set<string>();

    // add new markers, keep track of the added ones
    let doc = this.editor.getDoc();

    let transform = this.editor.transform;
    let get_cell_id = this.editor.get_cell_id;

    // TODO: test for diagnostic messages not being over-writen
    //  test case: from statistics import mean, bisect_left
    //  and do not use either; expected: title has "mean imported but unused; bisect_left imported and unused'
    // TODO: test case for severity class always being set, even if diagnostic has no severity

    let diagnostics_by_range = this.collapse_overlapping_diagnostics(
      response.diagnostics
    );

    diagnostics_by_range.forEach(
      (diagnostics: lsProtocol.Diagnostic[], range: lsProtocol.Range) => {
        const start = PositionConverter.lsp_to_cm(range.start);
        const end = PositionConverter.lsp_to_cm(range.end);

        let highest_severity_code = diagnostics
          .map(diagnostic => diagnostic.severity || default_severity)
          .sort()[0];

        const severity = diagnosticSeverityNames[highest_severity_code];

        // what a pity there is no hash in the standard library...
        // we could use this: https://stackoverflow.com/a/7616484 though it may not be worth it:
        //   the stringified diagnostic objects are only about 100-200 JS characters anyway,
        //   depending on the message length; this could be reduced using some structure-aware
        //   stringifier; such a stringifier could also prevent the possibility of having a false
        //   negative due to a different ordering of keys
        // obviously, the hash would prevent recovery of info from the key.
        let diagnostic_hash = JSON.stringify({
          // diagnostics without ranges
          diagnostics: diagnostics.map(diagnostic => [
            diagnostic.severity,
            diagnostic.message,
            diagnostic.code,
            diagnostic.source,
            diagnostic.relatedInformation
          ]),
          // the apparent marker position will change in the notebook with every line change for each marker
          // after the (inserted/removed) line - but such markers should not be invalidated,
          // i.e. the invalidation should be performed in the cell space, not in the notebook coordinate space,
          // thus we transform the coordinates and keep the cell id in the hash
          range: {
            start: transform(start),
            end: transform(end)
          },
          cell: get_cell_id(start)
        });
        markers_to_retain.add(diagnostic_hash);

        if (!this.marked_diagnostics.has(diagnostic_hash)) {
          let options: CodeMirror.TextMarkerOptions = {
            title: diagnostics
              .map(d => d.message + (d.source ? ' (' + d.source + ')' : ''))
              .join('\n'),
            className: 'cm-lsp-diagnostic cm-lsp-diagnostic-' + severity
          };
          let marker;
          try {
            marker = doc.markText(start, end, options);
          } catch (e) {
            console.warn(
              'Marking inspection (diagnostic text) failed, see following logs (2):'
            );
            console.log(diagnostics);
            console.log(e);
            return;
          }
          this.marked_diagnostics.set(diagnostic_hash, marker);
        }

        /*
      TODO and this:
        const childEl = document.createElement('div');
        childEl.classList.add('CodeMirror-lsp-guttermarker');
        childEl.title = diagnostic.message;
        this.editor.setGutterMarker(start.line, 'CodeMirror-lsp', childEl);
      do we want gutters?
     */
      }
    );

    // remove the markers which were not included in the new message
    this.marked_diagnostics.forEach(
      (marker: CodeMirror.TextMarker, diagnostic_hash: string) => {
        if (!markers_to_retain.has(diagnostic_hash)) {
          this.marked_diagnostics.delete(diagnostic_hash);
          marker.clear();
        }
      }
    );
  }
}
