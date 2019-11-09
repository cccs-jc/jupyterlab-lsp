""" API used by spec finders and manager
"""
import enum
import pathlib
import re
import shutil
import sys
from typing import (
    TYPE_CHECKING,
    Any,
    Awaitable,
    Callable,
    Dict,
    List,
    Optional,
    Pattern,
    Text,
)

from notebook.transutils import _
from traitlets import List as List_, Unicode, default
from traitlets.config import LoggingConfigurable

if TYPE_CHECKING:  # pragma: no cover
    from .manager import LanguageServerManager

LanguageServerSpec = Dict[Text, Any]
LanguageServerMessage = Dict[Text, Any]
KeyedLanguageServerSpecs = Dict[Text, LanguageServerSpec]
HandlerListenerCallback = Callable[
    [LanguageServerMessage, "LanguageServerManager"], Awaitable[None]
]


class SessionStatus(enum.Enum):
    """ States in which a language server session can be
    """

    NOT_STARTED = "not_started"
    STARTING = "starting"
    STARTED = "started"
    STOPPING = "stopping"
    STOPPED = "stopped"


class MessageListener(object):
    """ A base listener implementation
    """

    SCOPES = ["client", "server", "all"]

    listener = None  # type: HandlerListenerCallback
    language = None  # type: Optional[Pattern[Text]]
    method = None  # type: Optional[Pattern[Text]]

    def __init__(
        self,
        listener: HandlerListenerCallback,
        language: Optional[Text],
        method: Optional[Text],
    ):
        self.listener = listener
        self.language = re.compile(language) if language else None
        self.method = re.compile(method) if method else None

    async def __call__(
        self,
        scope: Text,
        message: "LanguageServerMessage",
        languages: List[Text],
        manager: "LanguageServerManager",
    ) -> None:
        """ actually dispatch the message to the listener
        """
        await self.listener(
            scope=scope, message=message, languages=languages, manager=manager
        )

    def wants(self, message: "LanguageServerMessage", languages: List[Text]):
        if self.method and re.match(self.method, message["method"]) is None:
            return False
        return self.language is None or any(
            [re.match(self.language, lang) is not None for lang in languages]
        )


class HasListeners:
    _listeners = {scope: [] for scope in MessageListener.SCOPES}

    @classmethod
    def register_message_listener(
        cls, scope: Text, language: Optional[Text] = None, method: Optional[Text] = None
    ):
        """ register a listener for language server protocol messages
        """

        def inner(listener: HandlerListenerCallback) -> HandlerListenerCallback:
            cls._listeners[scope].append(
                MessageListener(listener=listener, language=language, method=method)
            )
            return listener

        return inner

    @classmethod
    def unregister_message_listener(cls, listener: HandlerListenerCallback):
        """ unregister a listener for language server protocol messages
        """
        for scope in MessageListener.SCOPES:
            cls._listeners[scope] = [
                lst for lst in cls._listeners[scope] if lst.listener != listener
            ]


class LanguageServerManagerAPI(LoggingConfigurable, HasListeners):
    """ Public API that can be used for python-based spec finders and listeners
    """

    nodejs = Unicode(help=_("path to nodejs executable")).tag(config=True)

    node_roots = List_([], help=_("absolute paths in which to seek node_modules")).tag(
        config=True
    )

    extra_node_roots = List_(
        [], help=_("additional absolute paths to seek node_modules first")
    ).tag(config=True)

    def find_node_module(self, *path_frag):
        """ look through the node_module roots to find the given node module
        """
        all_roots = self.extra_node_roots + self.node_roots
        found = None

        for candidate_root in all_roots:
            candidate = pathlib.Path(candidate_root, "node_modules", *path_frag)
            self.log.debug("Checking for %s", candidate)
            if candidate.exists():
                found = str(candidate)
                break

        if found is None:  # pragma: no cover
            self.log.debug(
                "%s not found in node_modules of %s", pathlib.Path(path_frag), all_roots
            )

        return found

    @default("nodejs")
    def _default_nodejs(self):
        return (
            shutil.which("node") or shutil.which("nodejs") or shutil.which("nodejs.exe")
        )

    @default("node_roots")
    def _default_node_roots(self):
        """ get the "usual suspects" for where `node_modules` may be found

        - where this was launch (usually the same as NotebookApp.notebook_dir)
        - the JupyterLab staging folder (if available)
        - wherever conda puts it
        - wherever some other conventions put it
        """

        # check where the server was started first
        roots = [pathlib.Path.cwd()]

        # try jupyterlab staging next
        try:
            from jupyterlab import commands

            roots += [pathlib.Path(commands.get_app_dir()) / "staging"]
        except ImportError:  # pragma: no cover
            pass

        # conda puts stuff in $PREFIX/lib on POSIX systems
        roots += [pathlib.Path(sys.prefix) / "lib"]

        # ... but right in %PREFIX% on nt
        roots += [pathlib.Path(sys.prefix)]

        return roots


# Gotta be down here so it can by typed... really should have a IL
SpecMaker = Callable[[LanguageServerManagerAPI], KeyedLanguageServerSpecs]
