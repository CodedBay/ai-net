import os
from datetime import datetime, timedelta, timezone

import boto3

logs = boto3.client("logs")


def handler(event, context):
    now = datetime.now(timezone.utc)
    archive_day = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    next_day = archive_day + timedelta(days=1)
    date_key = archive_day.strftime("%Y-%m-%d")
    task_name = f"ai-net-{os.environ['ARCHIVE_ENVIRONMENT']}-{date_key}"
    existing = logs.describe_export_tasks(taskName=task_name).get("exportTasks", [])
    if existing:
        task = existing[0]
        return {"taskId": task["taskId"], "status": task["status"]["code"], "reused": True}

    task = logs.create_export_task(
        taskName=task_name,
        logGroupNamePrefix=os.environ["LOG_GROUP_PREFIX"],
        fromTime=int(archive_day.timestamp() * 1000),
        to=int(next_day.timestamp() * 1000),
        destination=os.environ["ARCHIVE_BUCKET"],
        destinationPrefix=f"cloudwatch/{os.environ['ARCHIVE_ENVIRONMENT']}/{archive_day.strftime('%Y/%m/%d')}",
    )
    return {"taskId": task["taskId"], "status": "PENDING", "reused": False}