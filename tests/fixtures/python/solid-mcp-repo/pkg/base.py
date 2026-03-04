import os
from .helpers import helper_value


class BaseOp:
    def execute(self, x):
        return helper_value(x) + len(os.getcwd())
