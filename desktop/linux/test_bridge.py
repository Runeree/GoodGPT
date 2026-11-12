"""No app interaction: regressions for draft and queued-message selection."""
import unittest
from bridge import allowed_url, empty_editor, own_queue_action, is_steer


class Node:
    def __init__(self, name="", value="", role="text", children=()):
        self.name, self.value, self.role = name, value, role
        self.children, self.parent = list(children), None
        for child in children:
            child.parent = self

    @property
    def childCount(self):
        return len(self.children)

    def getChildAtIndex(self, index):
        return self.children[index]

    def queryText(self):
        return self

    @property
    def characterCount(self):
        return len(self.value)

    def getText(self, start, end):
        return self.value[start:end]

    def getRoleName(self):
        return self.role


class Guards(unittest.TestCase):
    def test_chatgpt_url(self):
        self.assertTrue(allowed_url("https://chatgpt.com/c/123"))
        self.assertTrue(allowed_url("https://chat.openai.com/"))
        for url in ("https://chatgpt.com.evil.org", "https://evil.org/chatgpt.com", "http://chatgpt.com", "https://user@chatgpt.com", "file:///tmp/chatgpt.com"):
            self.assertFalse(allowed_url(url), url)

    def test_empty_placeholder(self):
        self.assertTrue(empty_editor(Node()))
        self.assertTrue(empty_editor(Node("Работайте с Codex", "Работайте с Codex\n")))
        self.assertTrue(empty_editor(Node("Work with Codex", "Work with Codex")))

    def test_real_draft(self):
        self.assertFalse(empty_editor(Node("Message", "Мой черновик")))
        self.assertFalse(empty_editor(Node("Message", "Work with Codex")))
        self.assertFalse(empty_editor(Node("Work with Codex", "Work with Codex и ещё текст")))

    def test_queue_own_row(self):
        editor = Node("Message")
        button = Node("Steer", role="push button")
        row = Node(children=[Node(value="Молодец!"), button])
        window = Node(children=[row, editor])
        self.assertTrue(is_steer(button))
        self.assertTrue(own_queue_action(button, editor, "Молодец!", window))
        self.assertFalse(own_queue_action(button, editor, "Другое сообщение", window))

    def test_composer_and_history_do_not_authorise_other_row(self):
        editor = Node("Message", "Молодец!")
        button = Node("Скорректировать", role="push button")
        other = Node(children=[Node(value="Запусти проверки"), button])
        parent = Node(children=[editor, other, Node(value="Молодец!")])
        window = Node(children=[parent])
        self.assertFalse(own_queue_action(button, editor, "Молодец!", window))

    def test_text_label_is_not_an_action(self):
        self.assertFalse(is_steer(Node("Steer")))
        self.assertTrue(is_steer(Node("Скорректировать", role="push button")))


if __name__ == "__main__":
    unittest.main()
