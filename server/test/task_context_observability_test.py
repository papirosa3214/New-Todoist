import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from task_context import build_context, serialize_context, context_observations
from unittest.mock import patch
class ObservabilityTest(unittest.TestCase):
 def test_sources_remain_distinct_and_truncation_is_visible(self):
  excerpts=[{"source":"kb","title":"lesson","excerpt":"x"*800},{"source":"mnemosyne","title":"memory","excerpt":"y"*800}]
  with patch("task_context._knowledge_from_kb",return_value=("ok",excerpts[:1])),patch("task_context._knowledge_from_mnemosyne",return_value=("ok",excerpts[1:])):
   ctx=build_context({"id":"a","title":"t"},{"id":"r"})
  full=context_observations(ctx,serialize_context(ctx))
  self.assertEqual(next(x for x in full if x["scenario"]=="kb")["outputCount"],1)
  clipped=context_observations(ctx,serialize_context(ctx,150))
  self.assertEqual(next(x for x in clipped if x["scenario"]=="mnemosyne")["outputCount"],0)
  self.assertEqual(next(x for x in clipped if x["scenario"]=="mnemosyne")["inputCount"],1)
if __name__=="__main__":unittest.main()
