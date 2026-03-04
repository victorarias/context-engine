from .base import BaseOp


class ChildOp(BaseOp):
    def execute(self, x):
        return super().execute(x) + 1
