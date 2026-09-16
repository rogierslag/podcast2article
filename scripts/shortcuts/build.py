"""Build an unsigned share-sheet Shortcut; sign on macOS before distributing."""
import argparse
import plistlib
import uuid
from pathlib import Path
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--origin', default='https://reads.rogierslag.nl')
parser.add_argument('--output', required=True)
args = parser.parse_args()
origin = urlsplit(args.origin)
if origin.scheme != 'https' or not origin.netloc or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
    parser.error('--origin must be an HTTPS origin without credentials, path, query or fragment')


def attachment(value):
    return {'WFSerializationType': 'WFTextTokenAttachment', 'Value': value}


def text_variable(value):
    return {'WFSerializationType': 'WFTextTokenString', 'Value': {
        'string': '\ufffc', 'attachmentsByRange': {'{0, 1}': value}
    }}


def output(action_id):
    return attachment({'Type': 'ActionOutput', 'OutputUUID': action_id, 'OutputName': 'Result'})


actions = []


def action(identifier, **parameters):
    action_id = str(uuid.uuid4()).upper()
    actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + identifier,
                    'WFWorkflowActionParameters': dict(parameters, UUID=action_id)})
    return action_id


urls = action('detect.link', WFInput=text_variable({'Type': 'ExtensionInput'}))
first = action('getitemfromlist', WFInput=output(urls), WFItemSpecifier='First Item')
encoded = action('urlencode', WFInput=text_variable(output(first)['Value']), WFEncodeMode='Encode')
prefix = args.origin.rstrip('/') + '/?sourceUrl='
url = action('url', WFURLActionURL={
    'WFSerializationType': 'WFTextTokenString',
    'Value': {'string': prefix + '\ufffc', 'attachmentsByRange': {
        '{%d, 1}' % len(prefix): {'Type': 'ActionOutput', 'OutputUUID': encoded, 'OutputName': 'URL Encoded Text'}
    }}
})
action('openurl', WFInput=output(url))
workflow = {
    'WFWorkflowName': 'Add to Reads',
    'WFWorkflowClientVersion': '3036.0.4.2',
    'WFWorkflowMinimumClientVersion': 900,
    'WFWorkflowMinimumClientVersionString': '900',
    'WFWorkflowIcon': {'WFWorkflowIconStartColor': 4251333119, 'WFWorkflowIconGlyphNumber': 59511},
    'WFWorkflowTypes': ['ActionExtension'],
    'WFWorkflowInputContentItemClasses': ['WFURLContentItem', 'WFStringContentItem'],
    'WFWorkflowHasShortcutInputVariables': True,
    'WFWorkflowImportQuestions': [],
    'WFWorkflowActions': actions,
}
Path(args.output).write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY))
